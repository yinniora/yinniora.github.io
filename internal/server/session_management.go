package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"pi-web/internal/auth"
	"pi-web/internal/workers"
)

const sessionTrashSchema = `CREATE TABLE IF NOT EXISTS session_trash (session_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`

// Trash is a visibility marker, never an edit, move or removal of a Pi JSONL.
// Keeping the original file makes restore lossless even if a terminal has it open.
func (s *Server) sessionTrashed(id string) (bool, error) {
	if s.db == nil || id == "" {
		return false, nil
	}
	var exists int
	err := s.db.QueryRow(`SELECT 1 FROM session_trash WHERE session_id = ?`, id).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return exists == 1, err
}

func (s *Server) visibleSession(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hidden, err := s.sessionTrashed(r.URL.Query().Get("id"))
		if err != nil {
			writeJSONError(w, 500, "cannot read session state")
			return
		}
		if hidden {
			writeJSONError(w, 410, "Session is in Trash. Restore it from the home page.")
			return
		}
		h(w, r)
	}
}

func (s *Server) handleTrash(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		rows, err := s.db.Query(`SELECT session_id, deleted_at FROM session_trash ORDER BY deleted_at DESC`)
		if err != nil {
			writeJSONError(w, 500, "cannot read trash")
			return
		}
		type item struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Project   string `json:"project"`
			DeletedAt string `json:"deletedAt"`
		}
		out := []item{}
		for rows.Next() {
			var v item
			if err := rows.Scan(&v.ID, &v.DeletedAt); err != nil {
				rows.Close()
				writeJSONError(w, 500, "cannot read trash")
				return
			}
			out = append(out, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			writeJSONError(w, 500, "cannot read trash")
			return
		}
		for i := range out {
			if v, err := s.cache.Resolve(s.sessionsDir, out[i].ID); err == nil {
				out[i].Name = v.Session.Name
				out[i].Project = v.Session.Project
			}
		}
		writeJSON(w, 200, map[string]any{"sessions": out})
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		ID        string `json:"id"`
		Restore   bool   `json:"restore"`
		Permanent bool   `json:"permanent"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Restore && body.Permanent {
		writeJSONError(w, 400, "choose either restore or permanent deletion")
		return
	}
	s.sessionManagementMu.Lock()
	defer s.sessionManagementMu.Unlock()
	resolved, err := s.cache.Resolve(s.sessionsDir, body.ID)
	if resolveOrWriteError(w, err) {
		return
	}
	id := resolved.Session.ID
	if body.Permanent {
		fileRemoved := false
		var rollbackRetirement func()
		defer func() {
			if !fileRemoved && rollbackRetirement != nil {
				rollbackRetirement()
			}
		}()
		if s.readSessionStatus(id) != nil {
			writeJSONError(w, 409, "Stop the running task before permanent deletion.")
			return
		}
		if s.chatSender != nil {
			retirer, ok := s.chatSender.(interface{ RetireIdle(string) (func(), error) })
			if !ok {
				writeJSONError(w, 503, "worker retirement unavailable")
				return
			}
			rollbackRetirement, err = retirer.RetireIdle(id)
			if err != nil {
				writeJSONError(w, 409, err.Error())
				return
			}
		}
		// Only session-owned content is removed. Working directories are untouched.
		tx, err := s.db.Begin()
		if err != nil {
			writeJSONError(w, 500, "cannot prepare permanent deletion")
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"chat_queue_items", "chat_queue_state", "annotations", "review_comments", "session_trash"} {
			if _, err = tx.Exec("DELETE FROM "+table+" WHERE session_id = ?", id); err != nil {
				writeJSONError(w, 500, "cannot prepare metadata cleanup")
				return
			}
		}
		if err := os.Remove(resolved.Path); err != nil {
			writeJSONError(w, 500, "cannot delete session file")
			return
		}
		fileRemoved = true
		err = tx.Commit()
		if err != nil {
			writeJSONError(w, 500, "session file deleted, but metadata cleanup failed")
			return
		}
		s.broadcast("__all__", "new-session")
		writeJSON(w, 200, map[string]any{"ok": true, "id": id})
		return
	}
	if body.Restore {
		_, err = s.db.Exec(`DELETE FROM session_trash WHERE session_id = ?`, id)
	} else {
		if s.chatSender != nil && s.chatSender.Status(id).State == workers.WorkerStateRunning {
			writeJSONError(w, 409, "Stop the running task before moving this session to Trash.")
			return
		}
		_, err = s.db.Exec(`INSERT INTO session_trash(session_id, deleted_at) VALUES(?, ?) ON CONFLICT(session_id) DO NOTHING`, id, s.now().UTC().Format(time.RFC3339))
	}
	if err != nil {
		writeJSONError(w, 500, "cannot update trash")
		return
	}
	if body.Restore {
		if restorer, ok := s.chatSender.(interface{ RestoreSession(string) }); ok {
			restorer.RestoreSession(id)
		}
	}
	s.broadcast("__all__", "new-session")
	s.broadcast(id, "reload")
	writeJSON(w, 200, map[string]any{"ok": true, "id": id})
}

func (s *Server) handleMarkdownExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	var b strings.Builder
	title := resolved.Session.Name
	if title == "" {
		title = resolved.Session.ID
	}
	fmt.Fprintf(&b, "# %s\n\n", strings.ReplaceAll(title, "\n", " "))
	for _, entry := range resolved.Session.Entries {
		message, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		var text strings.Builder
		switch content := message["content"].(type) {
		case string:
			text.WriteString(content)
		case []any:
			for _, raw := range content {
				if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
					if v, ok := block["text"].(string); ok {
						text.WriteString(v)
						text.WriteByte('\n')
					}
				}
			}
		}
		if strings.TrimSpace(text.String()) != "" {
			fmt.Fprintf(&b, "## %s\n\n%s\n\n", role, strings.TrimSpace(text.String()))
		}
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="conversation.md"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fmt.Fprint(w, b.String())
}

type connection struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Kind        string `json:"kind"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

func configuredConnections() []connection {
	var values []connection
	if json.Unmarshal([]byte(os.Getenv("PI_WEB_CONNECTIONS")), &values) != nil {
		return []connection{}
	}
	out := []connection{}
	seen := map[string]bool{}
	for _, v := range values {
		u, err := url.Parse(v.URL)
		if err != nil || v.ID == "" || seen[v.ID] || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			continue
		}
		ip := net.ParseIP(u.Hostname())
		privateHTTP := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && (ip.IsLoopback() || ip.IsPrivate() || (ip.To4() != nil && ip.To4()[0] == 100 && ip.To4()[1] >= 64 && ip.To4()[1] <= 127)))
		if u.Scheme != "https" && !(u.Scheme == "http" && privateHTTP) {
			continue
		}
		if v.Kind != "local" && v.Kind != "tailscale" {
			v.Kind = "remote"
		}
		v.URL = strings.TrimRight(v.URL, "/")
		seen[v.ID] = true
		out = append(out, v)
	}
	return out
}

func (s *Server) handleConnections(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	writeJSON(w, 200, map[string]any{"connections": configuredConnections(), "defaultWorkspace": os.Getenv("PI_WEB_DEFAULT_WORKSPACE")})
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		Target  string `json:"target"`
		Session string `json:"session"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	for _, c := range configuredConnections() {
		if c.ID != body.Target {
			continue
		}
		if s.devices != nil && c.Kind != "local" {
			if auth.ApprovedDeviceID(r) != "" {
				writeJSON(w, 200, map[string]any{"clientManaged": true, "transport": c.Kind})
			} else {
				if s.devices.bootstrap == nil {
					writeJSONError(w, 503, "remote client is not configured")
					return
				}
				metadata := s.devices.bootstrap()
				writeJSON(w, 200, map[string]any{"url": metadata["clientUrl"]})
			}
			return
		}
		if s.devices != nil && auth.ApprovedDeviceID(r) != "" && c.Kind == "local" {
			writeJSONError(w, 400, "The local connection is available on the Mac itself.")
			return
		}
		target, _ := url.Parse(c.URL)
		if body.Session != "" {
			target.Path = "/session"
			q := target.Query()
			q.Set("id", body.Session)
			target.RawQuery = q.Encode()
		}
		writeJSON(w, 200, map[string]any{"url": s.auth.PairingURL(target.String())})
		return
	}
	writeJSONError(w, 400, "unknown connection")
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	if id := auth.ApprovedDeviceID(r); id != "" && s.devices != nil {
		_ = s.devices.revoke(id)
	}
	http.SetCookie(w, &http.Cookie{Name: "pi_token", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

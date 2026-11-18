package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"time"

	"pi-web/internal/workers"
)

const computerModeSchema = `CREATE TABLE IF NOT EXISTS session_computer_mode (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','ask','allow')))`

type computerApprover interface {
	ComputerRequests(string) []workers.ComputerRequest
	ReplyComputerRequest(string, string, bool) error
}

func (s *Server) ComputerMode(sessionID string) string {
	var mode string
	if s.db != nil && s.db.QueryRow(`SELECT mode FROM session_computer_mode WHERE session_id = ?`, sessionID).Scan(&mode) == nil {
		return mode
	}
	return "ask"
}

func (s *Server) handleComputerUse(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	id := resolved.Session.ID
	manager, ok := s.chatSender.(computerApprover)
	if !ok {
		writeJSONError(w, 503, "computer approval is unavailable")
		return
	}
	mode := s.ComputerMode(id)
	if r.Method == http.MethodPost {
		var req struct {
			Action, Mode, RequestID string
			Allow                   bool
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		switch req.Action {
		case "mode":
			if req.Mode != "ask" && req.Mode != "allow" && req.Mode != "off" {
				writeJSONError(w, 400, "invalid computer mode")
				return
			}
			if _, err = s.db.ExecContext(r.Context(), `INSERT INTO session_computer_mode (session_id, mode) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode`, id, req.Mode); err != nil {
				writeJSONError(w, 500, "could not save computer mode")
				return
			}
			mode = req.Mode
			if mode == "off" {
				for _, pending := range manager.ComputerRequests(id) {
					_ = manager.ReplyComputerRequest(id, pending.ID, false)
				}
			}
		case "answer":
			if req.RequestID == "" || manager.ReplyComputerRequest(id, req.RequestID, req.Allow && mode != "off") != nil {
				writeJSONError(w, 409, "approval expired")
				return
			}
		case "check":
			if !resolved.Session.ChatAvailable {
				writeJSONError(w, 409, resolved.Session.ChatDisabledReason)
				return
			}
			if err := s.chatSender.EnsureWorker(r.Context(), id, resolved.Path); err != nil {
				writeJSONError(w, 503, "could not check computer tools")
				return
			}
		default:
			writeJSONError(w, 400, "unknown computer action")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	commands, checked, _ := s.chatSender.GetCommands(ctx, id)
	loaded := slices.ContainsFunc(commands, func(command workers.SlashCommand) bool { return command.Name == "computer-use" })
	_, packageErr := os.Stat(filepath.Join(s.agentDir, "npm", "node_modules", "@injaneity", "pi-computer-use", "package.json"))
	requests := manager.ComputerRequests(id)
	if requests == nil {
		requests = []workers.ComputerRequest{}
	}
	writeJSON(w, 200, map[string]any{"mode": mode, "requests": requests, "installed": loaded || packageErr == nil, "loaded": loaded, "checked": checked})
}

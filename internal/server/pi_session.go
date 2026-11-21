package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"pi-web/internal/workers"
)

type piSessionActions interface {
	PiSessionAction(context.Context, string, string, workers.PiSessionAction, string) (json.RawMessage, error)
}

func (s *Server) handlePiSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	action := workers.PiSessionStats
	switch r.Method {
	case http.MethodGet:
		if r.URL.Query().Get("download") == "html" {
			action = workers.PiSessionExport
		}
	case http.MethodPost:
		action = workers.PiSessionCompact
	default:
		writeJSONError(w, 405, "method not allowed")
		return
	}
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable {
		writeJSONError(w, 409, resolved.Session.ChatDisabledReason)
		return
	}
	id := resolved.Session.ID
	if s.readSessionStatus(id) != nil {
		writeJSONError(w, 409, "session is busy")
		return
	}
	pi, ok := s.chatSender.(piSessionActions)
	if !ok {
		writeJSONError(w, 503, "Pi session actions unavailable")
		return
	}
	var outputPath string
	if action == workers.PiSessionExport {
		tmp, err := os.MkdirTemp("", "yugo-pi-export-")
		if err != nil {
			writeJSONError(w, 500, "cannot prepare export")
			return
		}
		defer os.RemoveAll(tmp)
		outputPath = filepath.Join(tmp, "conversation.html")
	}
	parent, timeout := r.Context(), 30*time.Second
	if action == workers.PiSessionCompact {
		finish, accepted := s.beginManagedWork()
		if !accepted {
			writeJSONError(w, http.StatusConflict, workers.ErrRestarting.Error())
			return
		}
		defer finish()
		// Let Pi finish writing the compaction entry if the phone changes views.
		parent, timeout = context.WithoutCancel(parent), 4*time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	data, err := pi.PiSessionAction(ctx, id, resolved.Path, action, outputPath)
	if errors.Is(err, workers.ErrPiSessionBusy) {
		writeJSONError(w, 409, "session is busy")
		return
	}
	if err != nil {
		writeJSONError(w, 502, "Pi could not complete this action")
		return
	}
	switch action {
	case workers.PiSessionExport:
		root, err := os.OpenRoot(filepath.Dir(outputPath))
		if err != nil {
			writeJSONError(w, 502, "Pi export unavailable")
			return
		}
		defer root.Close()
		file, err := root.Open("conversation.html")
		if err != nil {
			writeJSONError(w, 502, "Pi export unavailable")
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			writeJSONError(w, 502, "Pi export unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="conversation.html"`)
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, "conversation.html", info.ModTime(), file)
	case workers.PiSessionCompact:
		s.broadcast(id, "reload")
		writeJSON(w, 200, map[string]bool{"ok": true})
	case workers.PiSessionStats:
		var stats workers.PiSessionStatistics
		if json.Unmarshal(data, &stats) != nil {
			writeJSONError(w, 502, "Pi returned invalid session statistics")
			return
		}
		writeJSON(w, 200, stats)
	}
}

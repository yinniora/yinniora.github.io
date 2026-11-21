package server

import (
	"context"
	"database/sql"
	"errors"
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
	ApplyComputerPolicy(string)
}

func (s *Server) ComputerMode(sessionID string) string {
	if s.db == nil {
		return "off"
	}
	var mode string
	switch err := s.db.QueryRow(`SELECT mode FROM session_computer_mode WHERE session_id = ?`, sessionID).Scan(&mode); {
	case err == nil:
		return mode
	case errors.Is(err, sql.ErrNoRows):
		return "ask"
	default:
		return "off"
	}
}

type computerUpdate struct {
	Action    string `json:"action"`
	Mode      string `json:"mode"`
	RequestID string `json:"requestID"`
	Allow     *bool  `json:"allow"`
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
	if r.Method == http.MethodPost {
		var req computerUpdate
		if !decodeJSONBody(w, r, &req) {
			return
		}
		switch req.Action {
		case "mode", "answer":
			if !s.updateComputerApproval(w, r, manager, id, resolved.Path, req) {
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
	commands, checked, commandErr := s.chatSender.GetCommands(ctx, id)
	loaded := slices.ContainsFunc(commands, func(command workers.SlashCommand) bool { return command.Name == "computer-use" })
	_, packageErr := os.Stat(filepath.Join(s.agentDir, "npm", "node_modules", "@injaneity", "pi-computer-use", "package.json"))
	requests := manager.ComputerRequests(id)
	if requests == nil {
		requests = []workers.ComputerRequest{}
	}
	writeJSON(w, 200, map[string]any{"mode": s.ComputerMode(id), "requests": requests, "installed": loaded || packageErr == nil, "loaded": loaded, "checked": checked && commandErr == nil})
}

func (s *Server) updateComputerApproval(w http.ResponseWriter, r *http.Request, manager computerApprover, id, path string, req computerUpdate) bool {
	s.sessionManagementMu.Lock()
	defer s.sessionManagementMu.Unlock()
	hidden, err := s.sessionTrashed(id)
	if err != nil {
		writeJSONError(w, 500, "cannot read session state")
		return false
	}
	if _, err := os.Stat(path); hidden || errors.Is(err, os.ErrNotExist) {
		writeJSONError(w, 410, "session is no longer available")
		return false
	} else if err != nil {
		writeJSONError(w, 500, "cannot read session state")
		return false
	}
	if req.Action == "answer" {
		if req.RequestID == "" || req.Allow == nil {
			writeJSONError(w, 400, "missing approval decision")
			return false
		}
		if manager.ReplyComputerRequest(id, req.RequestID, *req.Allow) != nil {
			writeJSONError(w, 409, "approval expired")
			return false
		}
		return true
	}
	if req.Mode != "ask" && req.Mode != "allow" && req.Mode != "off" {
		writeJSONError(w, 400, "invalid computer mode")
		return false
	}
	previous := s.ComputerMode(id)
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO session_computer_mode (session_id, mode) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode`, id, req.Mode); err != nil {
		writeJSONError(w, 500, "could not save computer mode")
		return false
	}
	if previous != req.Mode {
		manager.ApplyComputerPolicy(id)
	}
	return true
}

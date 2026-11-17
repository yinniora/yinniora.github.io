package server

import (
	"context"
	"net/http"
	"pi-web/internal/relay"
	"time"
)

func (s *Server) ApprovedRemoteDeviceIDs() []string {
	if s.devices == nil {
		return nil
	}
	s.devices.mu.Lock()
	defer s.devices.mu.Unlock()
	rows, err := s.db.Query(`SELECT id FROM approved_devices WHERE revoked_at='' ORDER BY id`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}
func (s *Server) handleRemoteSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !localDeviceAdmin(r) {
		writeJSONError(w, 403, "Remote settings can only be managed on the Mac itself.")
		return
	}
	if s.remoteControl == nil || s.devices == nil {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"enabled": true, "settings": s.remoteControl.PublicSettings()})
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var profile relay.ServerProfile
	if !decodeJSONBody(w, r, &profile) {
		return
	}
	if err := s.remoteControl.Validate(profile); err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	if s.devices.approve == nil || !s.devices.approvalMu.TryLock() {
		writeJSONError(w, 409, "Mac authentication is unavailable or already open.")
		return
	}
	defer s.devices.approvalMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if s.devices.approve(ctx, "remote-server:"+profile.ServerURL) != nil {
		writeJSONError(w, 403, "Mac authentication was not completed.")
		return
	}
	if err := s.remoteControl.Save(ctx, profile); err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	if msg, err := formatSSEJSONEvent("remote-config", s.remoteControl.Bootstrap()); err == nil {
		s.broadcast(globalSessID, msg)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "settings": s.remoteControl.PublicSettings()})
}

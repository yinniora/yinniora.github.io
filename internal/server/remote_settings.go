package server

import (
	"context"
	"net/http"
	"time"

	"pi-web/internal/relay"
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
		writeJSONError(w, 403, "Remote settings can only be managed on the host itself.")
		return
	}
	if s.remoteControl == nil || s.devices == nil {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"enabled": true, "settings": s.publicRemoteSettings()})
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var request struct {
		relay.ServerProfile
		SSH       relaySSHSetup `json:"ssh"`
		Action    string        `json:"action"`
		SetupCode string        `json:"setupCode"`
	}
	if !decodeJSONBody(w, r, &request) {
		return
	}
	profile := request.ServerProfile
	var activation relayActivation
	var sshSetup relaySSHSetup
	destination := profile.ServerURL
	switch request.Action {
	case "tailscale":
		if s.privateSignal == nil {
			writeJSONError(w, 409, "Private signaling is unavailable on this host.")
			return
		}
		destination = "Tailscale"
	case "lan":
		if s.enableLAN == nil {
			writeJSONError(w, 409, "Local network signaling is unavailable on this host.")
			return
		}
		destination = "LAN"
	case "ssh":
		if s.updater == nil {
			writeJSONError(w, 409, "SSH setup requires a YuGo release build.")
			return
		}
		var err error
		sshSetup, err = normalizeRelaySSHSetup(request.SSH)
		if err != nil {
			writeJSONError(w, 400, err.Error())
			return
		}
		destination = sshSetup.SSHUser + "@" + sshSetup.SSHHost + " · " + sshSetup.ServerURL
	case "activate":
		var err error
		activation, err = parseRelayActivation(request.SetupCode)
		if err != nil {
			writeJSONError(w, 400, err.Error())
			return
		}
		destination = activation.ServerURL
	case "", "profile":
		if err := s.remoteControl.Validate(profile); err != nil {
			writeJSONError(w, 400, err.Error())
			return
		}
	default:
		writeJSONError(w, 400, "unknown remote setup action")
		return
	}
	if s.devices.approve == nil || !s.devices.approvalMu.TryLock() {
		writeJSONError(w, 409, "System authentication is unavailable or already open.")
		return
	}
	defer s.devices.approvalMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if s.devices.approve(ctx, "remote-server:"+destination) != nil {
		writeJSONError(w, 403, "System authentication was not completed.")
		return
	}
	var err error
	switch request.Action {
	case "tailscale":
		var endpoint, consentURL string
		endpoint, consentURL, err = s.privateSignal(ctx)
		if consentURL != "" {
			writeJSON(w, 200, map[string]any{"ok": false, "consentUrl": consentURL})
			return
		}
		if err == nil {
			err = s.remoteControl.SetDirectURL(endpoint)
		}
	case "lan":
		err = s.enableLAN()
	case "ssh":
		activation, err = provisionRelaySSH(r.Context(), sshSetup, s.updater.Info().Current)
		if err == nil {
			profile, err = redeemRelayActivation(r.Context(), activation)
		}
		if err == nil {
			err = s.remoteControl.Save(r.Context(), profile)
		}
	case "activate":
		profile, err = redeemRelayActivation(ctx, activation)
		if err == nil {
			err = s.remoteControl.Save(ctx, profile)
		}
	default:
		err = s.remoteControl.Save(ctx, profile)
	}
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	if msg, err := formatSSEJSONEvent("remote-config", s.remoteControl.Bootstrap()); err == nil {
		s.broadcast(globalSessID, msg)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "settings": s.publicRemoteSettings()})
}

func (s *Server) publicRemoteSettings() map[string]any {
	settings := s.remoteControl.PublicSettings()
	settings["privateSetupAvailable"] = s.privateSignal != nil
	settings["lanSetupAvailable"] = s.enableLAN != nil
	return settings
}

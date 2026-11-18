package server

import (
	"errors"
	"net/http"

	"pi-web/internal/workers"
)

type extensionUIHandler interface {
	ExtensionUI(string) workers.ExtensionUI
	ReplyExtensionUI(string, workers.ExtensionAnswer) error
}

func (s *Server) handleExtensionUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	id := r.URL.Query().Get("id")
	pi, ok := s.chatSender.(extensionUIHandler)
	if !ok {
		writeJSONError(w, 503, "Pi extension UI unavailable")
		return
	}
	var answer workers.ExtensionAnswer
	r.Body = http.MaxBytesReader(w, r.Body, 80*1024)
	if !decodeJSONBody(w, r, &answer) {
		return
	}
	switch err := pi.ReplyExtensionUI(id, answer); {
	case errors.Is(err, workers.ErrExtensionExpired):
		writeJSONError(w, 409, "Pi extension request expired")
	case errors.Is(err, workers.ErrExtensionAnswer):
		writeJSONError(w, 400, "invalid Pi extension answer")
	case err != nil:
		writeJSONError(w, 502, "could not answer Pi extension")
	default:
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

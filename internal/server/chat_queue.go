package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/chatqueue"
	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

const queueSendTimeout = 5 * time.Minute

// /api/chat/queue: single endpoint that demuxes on method.
//
//   GET    /api/chat/queue?id=<sessionID>             — list items + paused
//   POST   /api/chat/queue?id=<sessionID>             — append an item
//   DELETE /api/chat/queue?id=<sessionID>&position=N  — remove an item
//   PATCH  /api/chat/queue?id=<sessionID>             — set paused flag
//
// On any state change, we broadcast a "queue" SSE event on the session topic
// so any other open tab refreshes its local view, and kick the drainer so it
// re-evaluates this session immediately rather than waiting for the periodic
// tick.

func (s *Server) handleChatQueue(w http.ResponseWriter, r *http.Request) {
	if s.chatQueue == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "chat queue unavailable")
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.handleChatQueueGet(w, r)
	case http.MethodPost:
		s.handleChatQueuePost(w, r)
	case http.MethodDelete:
		s.handleChatQueueDelete(w, r)
	case http.MethodPatch:
		s.handleChatQueuePatch(w, r)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE, PATCH")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) resolveQueueSession(r *http.Request, w http.ResponseWriter) (string, bool) {
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return "", false
	}
	return resolved.Session.ID, true
}

func (s *Server) handleChatQueueGet(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := s.resolveQueueSession(r, w)
	if !ok {
		return
	}
	snap, err := s.chatQueue.List(sessionID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "list queue: "+err.Error())
		return
	}
	if snap.Items == nil {
		snap.Items = []chatqueue.Item{} // ensure JSON encodes [] not null
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleChatQueuePost(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := s.resolveQueueSession(r, w)
	if !ok {
		return
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
		request, err := chat.ParseRequest(r, chat.DefaultMaxImageBytes, chat.DefaultMaxRequestBytes)
		if err != nil {
			writeChatRequestError(w, err)
			return
		}
		s.appendQueueItem(w, sessionID, request, r.FormValue("displayText"))
		return
	}
	var body struct {
		Action      string `json:"action"`
		Position    int64  `json:"position"`
		Message     string `json:"message"`
		DisplayText string `json:"displayText"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Action == "send-now" {
		s.handleQueueSendNow(w, r, sessionID, body.Position)
		return
	}
	message := strings.TrimSpace(body.Message)
	if message == "" {
		writeJSONError(w, http.StatusBadRequest, "message is required")
		return
	}
	s.appendQueueItem(w, sessionID, chat.Request{Message: message}, body.DisplayText)
}

func (s *Server) appendQueueItem(w http.ResponseWriter, sessionID string, request chat.Request, displayText string) {
	item, err := s.chatQueue.AddRequest(sessionID, request, strings.TrimSpace(displayText))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "add queue item: "+err.Error())
		return
	}
	s.notifyQueueChanged(sessionID)
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) handleQueueSendNow(w http.ResponseWriter, r *http.Request, sessionID string, position int64) {
	if position <= 0 {
		writeJSONError(w, http.StatusBadRequest, "position must be positive")
		return
	}
	if s.chatSender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "chat unavailable")
		return
	}
	if _, busy := s.queueDispatches.LoadOrStore(sessionID, struct{}{}); busy {
		writeJSONError(w, http.StatusConflict, workers.ErrPiSessionBusy.Error())
		return
	}
	defer s.queueDispatches.Delete(sessionID)
	resolved, err := sessions.ResolveByID(s.sessionsDir, sessionID)
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable {
		writeJSONError(w, http.StatusConflict, resolved.Session.ChatDisabledReason)
		return
	}
	item, exists, err := s.chatQueue.Find(sessionID, position)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not read queue item")
		return
	}
	if !exists {
		writeJSONError(w, http.StatusNotFound, "queued message no longer exists")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), queueSendTimeout)
	defer cancel()
	if err = s.sendQueued(ctx, resolved.Path, item, false); err != nil {
		if errors.Is(err, workers.ErrRestarting) {
			writeJSONError(w, http.StatusConflict, workers.ErrRestarting.Error())
		} else if errors.Is(err, workers.ErrPiSessionBusy) {
			writeJSONError(w, http.StatusConflict, workers.ErrPiSessionBusy.Error())
		} else {
			writeJSONError(w, http.StatusBadGateway, "Pi did not acknowledge the queued message")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleChatQueueDelete(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := s.resolveQueueSession(r, w)
	if !ok {
		return
	}
	posStr := r.URL.Query().Get("position")
	if posStr == "" {
		writeJSONError(w, http.StatusBadRequest, "position is required")
		return
	}
	pos, err := strconv.ParseInt(posStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "position must be an integer")
		return
	}
	if _, busy := s.queueDispatches.LoadOrStore(sessionID, struct{}{}); busy {
		writeJSONError(w, http.StatusConflict, workers.ErrPiSessionBusy.Error())
		return
	}
	defer s.queueDispatches.Delete(sessionID)
	if pos <= 0 {
		writeJSONError(w, http.StatusBadRequest, "position must be positive")
		return
	}
	item, exists, err := s.chatQueue.Find(sessionID, pos)
	if err != nil || !exists {
		writeJSONError(w, http.StatusNotFound, "queued message no longer exists")
		return
	}
	if err := s.chatQueue.Remove(sessionID, pos); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "remove queue item: "+err.Error())
		return
	}
	s.notifyQueueChanged(sessionID)
	if r.URL.Query().Get("edit") == "1" {
		writeJSON(w, http.StatusOK, item)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleChatQueuePatch(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := s.resolveQueueSession(r, w)
	if !ok {
		return
	}
	var body struct {
		Paused *bool `json:"paused"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Paused == nil {
		writeJSONError(w, http.StatusBadRequest, "paused is required")
		return
	}
	if err := s.chatQueue.SetPaused(sessionID, *body.Paused); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "set paused: "+err.Error())
		return
	}
	s.notifyQueueChanged(sessionID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paused": *body.Paused})
}

// notifyQueueChanged informs other tabs (via SSE) and the drainer that this
// session's queue state changed. The drainer kick is best-effort: a nil
// drainer (e.g. tests) is a no-op. The SSE payload is intentionally tiny —
// listeners just refetch /api/chat/queue to get the new state.
func (s *Server) notifyQueueChanged(sessionID string) {
	if msg, err := formatSSEJSONEvent("queue", map[string]any{"sessionId": sessionID}); err == nil {
		s.broadcast(sessionID, msg)
	}
	if s.queueDrainer != nil {
		s.queueDrainer.kick(sessionID)
	}
}

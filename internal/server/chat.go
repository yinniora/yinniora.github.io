package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

type ChatSender interface {
	Send(ctx context.Context, sessionID, sessionPath string, chat chat.Request) error
	SetModel(ctx context.Context, sessionID, sessionPath, provider, modelID string) error
	SetThinkingLevel(ctx context.Context, sessionID, sessionPath, level string) error
	Abort(ctx context.Context, sessionID string) error
	GetState(ctx context.Context, sessionID string) (workers.WorkerStatus, error)
	GetCommands(ctx context.Context, sessionID string) ([]workers.SlashCommand, bool, error)
	Status(sessionID string) workers.WorkerStatus
	EnsureWorker(ctx context.Context, sessionID, sessionPath string) error
}

var chatRequestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{12,80}$`)

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable {
		writeJSONError(w, http.StatusConflict, resolved.Session.ChatDisabledReason)
		return
	}
	ack := map[string]any{"ok": true, "status": "queued"}
	requestID := r.URL.Query().Get("request")
	receipt := ""
	if requestID != "" {
		if !chatRequestID.MatchString(requestID) {
			writeJSONError(w, http.StatusBadRequest, "invalid chat request ID")
			return
		}
		receipt = resolved.Session.ID + "\x00" + requestID
		s.chatRequestMu.Lock()
		accepted := s.acceptedChatRequests[receipt].After(time.Now())
		s.chatRequestMu.Unlock()
		if accepted {
			writeJSON(w, http.StatusAccepted, ack)
			return
		}
	}
	if s.chatSender != nil && s.chatSender.Status(resolved.Session.ID).Compacting {
		writeJSONError(w, 409, "session is busy")
		return
	}
	chatReq, err := chat.ParseRequest(r, chat.DefaultMaxImageBytes, chat.DefaultMaxRequestBytes)
	if err != nil {
		writeChatRequestError(w, err)
		return
	}
	chatReq.RequestID = requestID
	if s.chatSender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "chat unavailable")
		return
	}
	sessionID := resolved.Session.ID
	sessionPath := resolved.Path
	uploadDir, err := s.saveChatFiles(sessionID, &chatReq)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not save attached files")
		return
	}
	deliver := func(ctx context.Context) {
		if err := s.chatSender.Send(ctx, sessionID, sessionPath, chatReq); err != nil && !errors.Is(err, context.Canceled) {
			if errors.Is(err, workers.ErrPiContextCompaction) && s.chatQueue != nil && len(chatReq.Images) == 0 {
				// Pi never received this prompt. Keep it available for a manual retry.
				if pauseErr := s.chatQueue.SetPaused(sessionID, true); pauseErr == nil {
					if _, addErr := s.chatQueue.Add(sessionID, chatReq.Message, chatReq.Message); addErr == nil {
						s.notifyQueueChanged(sessionID)
					}
				}
			}
			fmt.Fprintf(os.Stderr, "chat send failed for %s: %v\n", sessionID, err)
		}
	}
	if receipt != "" {
		s.chatRequestMu.Lock()
		now := time.Now()
		accepted := s.acceptedChatRequests[receipt].After(now)
		if accepted {
			s.chatRequestMu.Unlock()
			if uploadDir != "" {
				_ = os.RemoveAll(uploadDir)
			}
			writeJSON(w, http.StatusAccepted, ack)
			return
		}
		for key, expires := range s.acceptedChatRequests {
			if !expires.After(now) {
				delete(s.acceptedChatRequests, key)
			}
		}
		started := len(s.acceptedChatRequests) < 4096 && s.startTask(deliver)
		if started {
			if s.acceptedChatRequests == nil {
				s.acceptedChatRequests = make(map[string]time.Time)
			}
			s.acceptedChatRequests[receipt] = now.Add(5 * time.Minute)
		}
		s.chatRequestMu.Unlock()
		if started {
			writeJSON(w, http.StatusAccepted, ack)
			return
		}
	} else if s.startTask(deliver) {
		writeJSON(w, http.StatusAccepted, ack)
		return
	}
	if uploadDir != "" {
		_ = os.RemoveAll(uploadDir)
	}
	writeJSONError(w, http.StatusServiceUnavailable, "could not submit chat right now")
}

func writeChatRequestError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, chat.ErrImageTooLarge), errors.Is(err, chat.ErrFileTooLarge), errors.As(err, new(*http.MaxBytesError)):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, chat.ErrUnsupportedImageType):
		status = http.StatusUnsupportedMediaType
	}
	writeJSONError(w, status, err.Error())
}

// recentSessionActivityWindow is the grace period after a JSONL write during
// which a session is still reported as "running" even when no in-process
// chat worker and no session-status file claims it. Kept short so the
// "running" status / Cancel button doesn't linger after the assistant
// finishes streaming its final message.
const recentSessionActivityWindow = 800 * time.Millisecond
const sessionStatusTTL = 10 * time.Second

type sessionStatusFile struct {
	State     string `json:"state"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) readSessionStatus(sessionID string) *workers.WorkerStatus {
	if sessionID == "" {
		return nil
	}
	path := filepath.Join(s.sessionStatusDir(), sessionID)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var status sessionStatusFile
	if err := json.Unmarshal(data, &status); err != nil {
		return nil
	}
	if status.State != "running" {
		return nil
	}
	updatedAt, err := time.Parse(time.RFC3339, status.UpdatedAt)
	if err != nil {
		return nil
	}
	if time.Since(updatedAt) > sessionStatusTTL {
		return nil
	}
	return &workers.WorkerStatus{State: workers.WorkerStateRunning}
}

func (s *Server) handleCancelChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if s.chatSender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "chat unavailable")
		return
	}
	if err := s.chatSender.Abort(r.Context(), resolved.Session.ID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = os.Remove(filepath.Join(s.sessionStatusDir(), resolved.Session.ID))
	s.recomputeAndBroadcastStatus(resolved.Session.ID)
	s.broadcast(resolved.Session.ID, "reload")
	writeJSON(w, 0, map[string]any{"ok": true, "status": "cancelled"})
}

func (s *Server) handleWorkerStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("id")

	status := workers.WorkerStatus{State: workers.WorkerStateIdle}
	running := s.computeRunningStatus(sessionID)
	if running {
		status.State = workers.WorkerStateRunning
	}
	if s.chatSender != nil {
		// Do not create/prewarm workers from status polling. A browser can poll
		// many visible sessions at once; if one pi RPC switch_session hangs, eager
		// prewarming accumulates stuck `pi --mode rpc` processes and starves real
		// chat requests. Only report state for an already-created worker here.
		state := s.chatSender.Status(sessionID)
		if !running {
			stateCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if fresh, err := s.chatSender.GetState(stateCtx, sessionID); err == nil {
				state = fresh
			}
		}
		status.Model = state.Model
		status.ModelName = state.ModelName
		status.ModelProvider = state.ModelProvider
		status.ThinkingLevel = state.ThinkingLevel
		status.ThinkingLevels = state.ThinkingLevels
		status.Compacting = state.Compacting
		status.CompactionFailed = state.CompactionFailed
		status.WaitingForInput = state.WaitingForInput
		if !running && state.Error == workers.ErrPiContextCompaction.Error() {
			status.State, status.Error = workers.WorkerStateError, state.Error
		}
		status.HandledPrompt = state.HandledPrompt
	}
	if pi, ok := s.chatSender.(extensionUIHandler); ok {
		ui := pi.ExtensionUI(sessionID)
		if len(ui.Dialogs)+len(ui.Notices) > 0 {
			status.ExtensionUI = &ui
		}
	}
	writeJSON(w, 0, status)
}

// handleCommands serves the slash-command palette for a session's composer.
// By default it peeks at an existing worker and never spawns one; with
// ?load=1 it ensures a worker first (used when the user opens the palette and
// no worker exists yet). Any failure to query commands degrades to an empty
// list rather than an error — the palette is a non-critical affordance and
// must never break the composer.
func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if s.chatSender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "chat unavailable")
		return
	}
	sessionID := resolved.Session.ID
	if r.URL.Query().Get("load") == "1" {
		if err := s.chatSender.EnsureWorker(r.Context(), sessionID, resolved.Path); err != nil {
			fmt.Fprintf(os.Stderr, "commands: ensure worker failed for %s: %v\n", sessionID, err)
		}
	}
	cmds, ready, err := s.chatSender.GetCommands(r.Context(), sessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "commands: query failed for %s: %v\n", sessionID, err)
		cmds = nil
	}
	if cmds == nil {
		cmds = []workers.SlashCommand{}
	}
	writeJSON(w, 0, map[string]any{"commands": cmds, "workerReady": ready})
}

func (s *Server) hasRecentSessionActivity(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	now := s.now()
	s.fileModMu.RLock()
	mod, ok := s.fileMod[sessionID]
	s.fileModMu.RUnlock()
	if !ok {
		return false
	}
	return !mod.IsZero() && now.Sub(mod) <= recentSessionActivityWindow
}

func (s *Server) handleSetModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	var body struct {
		Provider string `json:"provider"`
		ModelID  string `json:"modelId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Provider == "" || body.ModelID == "" {
		writeJSONError(w, http.StatusBadRequest, "provider and modelId required")
		return
	}
	if err := s.chatSender.SetModel(r.Context(), resolved.Session.ID, resolved.Path, body.Provider, body.ModelID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// A model used before keeps its last effort (Pi applies it on the switch).
	// A model never used starts at its official default instead of the
	// previous model's effort.
	if !s.hasModelThinkingLevel(body.Provider, body.ModelID) {
		if level := officialDefaultLevel(body.ModelID); level != "" {
			_ = s.chatSender.SetThinkingLevel(r.Context(), resolved.Session.ID, resolved.Path, level)
		}
	}
	result := map[string]any{"ok": true}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	level := ""
	if state, err := s.chatSender.GetState(ctx, resolved.Session.ID); err == nil &&
		state.ModelProvider == body.Provider && state.Model == body.ModelID {
		result["thinkingLevel"] = state.ThinkingLevel
		result["thinkingLevels"] = state.ThinkingLevels
		level = state.ThinkingLevel
	}
	s.rememberModelChoice(body.Provider, body.ModelID, level)
	writeJSON(w, 0, result)
}

func (s *Server) handleSetThinkingLevel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	var body struct {
		Level string `json:"level"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Level == "" {
		writeJSONError(w, http.StatusBadRequest, "level required")
		return
	}
	if err := s.chatSender.SetThinkingLevel(r.Context(), resolved.Session.ID, resolved.Path, body.Level); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := s.chatSender.Status(resolved.Session.ID)
	if state, err := s.chatSender.GetState(r.Context(), resolved.Session.ID); err == nil {
		status.ThinkingLevel = state.ThinkingLevel
		s.rememberModelChoice(state.ModelProvider, state.Model, state.ThinkingLevel)
	}
	writeJSON(w, 0, map[string]any{"ok": true, "thinkingLevel": status.ThinkingLevel})
}

// Best effort: a failed write leaves the previous defaults in place.
func (s *Server) rememberModelChoice(provider, modelID, level string) {
	if s.agentDir == "" {
		return
	}
	s.modelConfigMu.Lock()
	defer s.modelConfigMu.Unlock()
	_ = rememberModelChoice(s.agentDir, provider, modelID, level)
}

func (s *Server) hasModelThinkingLevel(provider, modelID string) bool {
	if s.agentDir == "" {
		return true
	}
	var settings struct{ ModelThinkingLevels map[string]string }
	raw, err := os.ReadFile(filepath.Join(s.agentDir, "settings.json"))
	if err != nil || json.Unmarshal(raw, &settings) != nil {
		return false
	}
	return settings.ModelThinkingLevels[provider+"/"+modelID] != ""
}

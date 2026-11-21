package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"

	"pi-web/internal/workers"
)

type ManagedUpdateResult struct {
	NeedsRestart bool   `json:"needsRestart"`
	Version      string `json:"version,omitempty"`
	Mode         string `json:"mode,omitempty"`
}

type managedUpdateState struct {
	mu          sync.Mutex
	staging     bool
	restarting  bool
	pending     ManagedUpdateResult
	pendingWork int
}

type managedWorkerGuard interface {
	PrepareRestart() (release func(), err error)
}

var managedUpdateVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+-yugo\.[0-9]+$`)

// ErrManagedUpdateRestage reports that a failed restart restored the old
// executable, so the update must be prepared again before retrying.
var ErrManagedUpdateRestage = errors.New("prepare the update again before restarting")

func (s *Server) allowManagedUpdate(w http.ResponseWriter, r *http.Request) bool {
	if !localDeviceAdmin(r) || s.auth == nil || !s.auth.Enabled() {
		writeJSONError(w, http.StatusForbidden, "updates require a signed-in local desktop")
		return false
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return false
	}
	return true
}

func (s *Server) handleManagedUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.allowManagedUpdate(w, r) {
		return
	}
	if s.managedUpdate == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "managed updates are unavailable")
		return
	}
	var request struct {
		Version string `json:"version"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || !managedUpdateVersion.MatchString(request.Version) || decoder.Decode(new(any)) != io.EOF {
		writeJSONError(w, http.StatusBadRequest, "invalid YuGo update version")
		return
	}

	state := &s.managedUpdateState
	state.mu.Lock()
	if state.staging || state.restarting {
		state.mu.Unlock()
		writeJSONError(w, http.StatusConflict, "an update operation is already in progress")
		return
	}
	if pending := state.pending; pending.NeedsRestart {
		state.mu.Unlock()
		if pending.Version == request.Version {
			writeJSON(w, http.StatusOK, pending)
		} else {
			writeJSONError(w, http.StatusConflict, "restart to finish the staged update first")
		}
		return
	}
	state.staging = true
	state.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	result, err := s.managedUpdate(ctx, request.Version)
	if result.Version == "" {
		result.Version = request.Version
	}
	state.mu.Lock()
	state.staging = false
	if err == nil && result.NeedsRestart {
		state.pending = result
	}
	state.mu.Unlock()
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, workers.ErrRestartBusy) || errors.Is(err, workers.ErrRestarting) {
			status = http.StatusConflict
		}
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleManagedRestart(w http.ResponseWriter, r *http.Request) {
	if !s.allowManagedUpdate(w, r) {
		return
	}
	guard, ok := s.chatSender.(managedWorkerGuard)
	if s.managedRestart == nil || !ok {
		writeJSONError(w, http.StatusServiceUnavailable, "managed restart is unavailable")
		return
	}

	state := &s.managedUpdateState
	state.mu.Lock()
	if state.staging || state.restarting || !state.pending.NeedsRestart {
		state.mu.Unlock()
		writeJSONError(w, http.StatusConflict, "no staged update is ready to restart")
		return
	}
	if state.pendingWork > 0 {
		state.mu.Unlock()
		writeJSONError(w, http.StatusConflict, workers.ErrRestartBusy.Error())
		return
	}
	state.restarting = true
	state.mu.Unlock()

	release, err := guard.PrepareRestart()
	if err != nil {
		state.mu.Lock()
		state.restarting = false
		state.mu.Unlock()
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	// The application commits a detached restart and lets this response flush.
	if err := s.managedRestart(); err != nil {
		release()
		restage := errors.Is(err, ErrManagedUpdateRestage)
		state.mu.Lock()
		state.restarting = false
		if restage {
			state.pending = ManagedUpdateResult{}
		}
		state.mu.Unlock()
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "restage": restage})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
	// If the old process is still alive, its update never took effect. Let it
	// serve new work again and keep the restart available for diagnosis/retry.
	time.AfterFunc(15*time.Second, func() {
		release()
		state.mu.Lock()
		state.restarting = false
		state.mu.Unlock()
	})
}

// beginManagedWork holds an admission from request acceptance until its
// worker has recorded the prompt (or the operation fails).
func (s *Server) beginManagedWork() (finish func(), accepted bool) {
	state := &s.managedUpdateState
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.restarting {
		return nil, false
	}
	state.pendingWork++
	return func() {
		state.mu.Lock()
		state.pendingWork--
		state.mu.Unlock()
	}, true
}

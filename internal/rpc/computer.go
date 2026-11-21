package rpc

import (
	_ "embed"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"pi-web/internal/workers"
)

//go:embed computer_guard.mjs
var computerGuard []byte

const computerApprovalTitle = "YuGo Pi computer approval"
const computerApprovalTimeout = 2 * time.Minute
const maxPendingComputerApprovals = 16

type pendingComputerApproval struct {
	workers.ComputerRequest
	digest string
}

func InstallComputerGuard(dir string) (string, error) {
	return installWorkerExtension(dir, "yugo-computer-guard.mjs", computerGuard)
}

func (w *piRPCWorker) handleComputerApproval(id, payload string, timeoutMs int64) {
	var message struct {
		Tool   string `json:"tool"`
		Detail string `json:"detail"`
		Digest string `json:"digest"`
	}
	if len(payload) > 8192 || json.Unmarshal([]byte(payload), &message) != nil || message.Tool == "" || len(message.Digest) != 64 {
		_ = w.writeComputerDecision(id, "cancelled")
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	if _, duplicate := w.computerRequests[id]; duplicate {
		return
	}
	if w.extensionClosed || w.status.State == workers.WorkerStateError || w.computerMode == nil {
		_ = w.writeComputerDecision(id, "cancelled")
		return
	}
	switch w.computerMode() {
	case "allow":
		_ = w.writeComputerDecision(id, "approved")
	case "ask":
		if _, repeated := w.computerDenied[message.Digest]; repeated {
			_ = w.writeComputerDecision(id, "repeated")
			return
		}
		if len(w.computerRequests) >= maxPendingComputerApprovals {
			_ = w.writeComputerDecision(id, "cancelled")
			return
		}
		timeout := computerApprovalTimeout
		if timeoutMs > 0 && timeoutMs < timeout.Milliseconds() {
			timeout = time.Duration(timeoutMs) * time.Millisecond
		}
		if w.computerRequests == nil {
			w.computerRequests = make(map[string]pendingComputerApproval)
		}
		w.computerRequests[id] = pendingComputerApproval{
			ComputerRequest: workers.ComputerRequest{ID: id, Tool: message.Tool, Detail: message.Detail, Expires: time.Now().Add(timeout)},
			digest:          message.Digest,
		}
	default:
		_ = w.writeComputerDecision(id, "off")
	}
}

func (w *piRPCWorker) ComputerRequests() []workers.ComputerRequest {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	var out []workers.ComputerRequest
	for _, request := range w.computerRequests {
		out = append(out, request.ComputerRequest)
	}
	slices.SortFunc(out, func(a, b workers.ComputerRequest) int { return a.Expires.Compare(b.Expires) })
	return out
}

func (w *piRPCWorker) ReplyComputerRequest(id string, allow bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	request, found := w.computerRequests[id]
	if !found || w.extensionClosed || w.status.State == workers.WorkerStateError || w.computerMode == nil {
		return errors.New("approval expired")
	}
	mode := w.computerMode()
	decision := "declined"
	if mode != "allow" && mode != "ask" {
		decision = "off"
	} else if allow {
		decision = "approved"
	}
	if err := w.writeComputerDecision(request.ID, decision); err != nil {
		return err
	}
	delete(w.computerRequests, id)
	if decision == "declined" {
		w.rememberDeclinedComputerActionLocked(request.digest)
	}
	if decision == "off" {
		return errors.New("approval expired")
	}
	return nil
}

func (w *piRPCWorker) ApplyComputerPolicy() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	if w.computerMode == nil || w.extensionClosed {
		return
	}
	mode := w.computerMode()
	clear(w.computerDenied)
	if mode == "ask" {
		return
	}
	decision := "off"
	if mode == "allow" {
		decision = "approved"
	}
	for id := range w.computerRequests {
		_ = w.writeComputerDecision(id, decision)
		delete(w.computerRequests, id)
	}
}

func (w *piRPCWorker) expireComputerRequestsLocked() {
	now := time.Now()
	for id, request := range w.computerRequests {
		if !now.Before(request.Expires) {
			delete(w.computerRequests, id)
			w.rememberDeclinedComputerActionLocked(request.digest)
		}
	}
}

func (w *piRPCWorker) rememberDeclinedComputerActionLocked(digest string) {
	if len(w.computerDenied) >= 32 {
		return
	}
	if w.computerDenied == nil {
		w.computerDenied = make(map[string]struct{})
	}
	w.computerDenied[digest] = struct{}{}
}

func (w *piRPCWorker) writeComputerDecision(id, decision string) error {
	return w.writeExtensionAnswer(workers.ExtensionAnswer{ID: id, Value: &decision})
}

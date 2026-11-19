package rpc

import (
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"

	"pi-web/internal/workers"
)

//go:embed computer_guard.mjs
var computerGuard []byte

const computerApprovalTitle = "YuGo Pi computer approval"
const computerPolicyTitle = "YuGo Pi computer policy"

func InstallComputerGuard(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "yugo-computer-guard.mjs")
	f, err := os.CreateTemp(dir, ".computer-guard-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(computerGuard)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	return path, os.Rename(f.Name(), path)
}

func (w *piRPCWorker) handleComputerApproval(id, payload string, timeoutMs int64) {
	var message struct {
		Tool   string `json:"tool"`
		Detail string `json:"detail"`
	}
	if len(payload) > 8192 || json.Unmarshal([]byte(payload), &message) != nil || message.Tool == "" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	switch w.computerMode() {
	case "allow":
		_ = w.writeComputerResponse(id, true)
	case "off":
		_ = w.writeComputerResponse(id, false)
	default:
		if w.computerDenied {
			_ = w.writeComputerResponse(id, false)
			return
		}
		timeout := 2 * time.Minute
		if timeoutMs > 0 && timeoutMs < timeout.Milliseconds() {
			timeout = time.Duration(timeoutMs) * time.Millisecond
		}
		if w.computerRequests == nil {
			w.computerRequests = make(map[string]workers.ComputerRequest)
		}
		w.computerRequests[id] = workers.ComputerRequest{ID: id, Tool: message.Tool, Detail: message.Detail, Expires: time.Now().Add(timeout)}
	}
}

func (w *piRPCWorker) ComputerRequests() []workers.ComputerRequest {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	var out []workers.ComputerRequest
	for _, request := range w.computerRequests {
		out = append(out, request)
	}
	slices.SortFunc(out, func(a, b workers.ComputerRequest) int { return a.Expires.Compare(b.Expires) })
	return out
}

func (w *piRPCWorker) ReplyComputerRequest(id string, allow bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	request, found := w.computerRequests[id]
	if !found {
		return errors.New("approval expired")
	}
	mode := w.computerMode()
	allow = allow && mode != "off"
	if err := w.writeComputerResponse(request.ID, allow); err != nil {
		return err
	}
	delete(w.computerRequests, id)
	w.computerDenied = w.computerDenied || !allow
	return nil
}

func (w *piRPCWorker) ApplyComputerPolicy() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.expireComputerRequestsLocked()
	mode := w.computerMode()
	if mode != "allow" && mode != "off" {
		return
	}
	if mode == "allow" {
		w.computerDenied = false
	}
	for id := range w.computerRequests {
		if w.writeComputerResponse(id, mode == "allow") == nil {
			delete(w.computerRequests, id)
		}
	}
}

func (w *piRPCWorker) expireComputerRequestsLocked() {
	now := time.Now()
	for id, request := range w.computerRequests {
		if !now.Before(request.Expires) {
			delete(w.computerRequests, id)
			w.computerDenied = true
		}
	}
}

func (w *piRPCWorker) writeComputerResponse(id string, allow bool) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return WriteCommand(w.stdin, map[string]any{"type": "extension_ui_response", "id": id, "confirmed": allow})
}

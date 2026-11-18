package rpc

import (
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"pi-web/internal/workers"
)

//go:embed computer_guard.mjs
var computerGuard []byte

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

func (w *piRPCWorker) handleComputerApproval(line string) {
	var request struct{ ID, Title, Method, Message string }
	if json.Unmarshal([]byte(line), &request) != nil || request.ID == "" || request.Method != "confirm" || request.Title != "YuGo Pi computer approval" {
		return
	}
	var message struct{ Tool, Detail string }
	if json.Unmarshal([]byte(request.Message), &message) != nil || message.Tool == "" || len(request.Message) > 8192 {
		return
	}
	switch w.computerMode() {
	case "allow":
		_ = w.writeComputerResponse(request.ID, true)
	case "off":
		_ = w.writeComputerResponse(request.ID, false)
	default:
		w.mu.Lock()
		if w.computerRequests == nil {
			w.computerRequests = make(map[string]workers.ComputerRequest)
		}
		w.computerRequests[request.ID] = workers.ComputerRequest{ID: request.ID, Tool: message.Tool, Detail: message.Detail, Expires: time.Now().Add(42 * time.Second)}
		w.mu.Unlock()
	}
}

func (w *piRPCWorker) ComputerRequests() []workers.ComputerRequest {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []workers.ComputerRequest
	for id, request := range w.computerRequests {
		if time.Now().Before(request.Expires) {
			out = append(out, request)
		} else {
			delete(w.computerRequests, id)
		}
	}
	return out
}

func (w *piRPCWorker) ReplyComputerRequest(id string, allow bool) error {
	w.mu.Lock()
	request, found := w.computerRequests[id]
	delete(w.computerRequests, id)
	w.mu.Unlock()
	if !found || !time.Now().Before(request.Expires) {
		return errors.New("approval expired")
	}
	return w.writeComputerResponse(id, allow)
}

func (w *piRPCWorker) writeComputerResponse(id string, allow bool) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return WriteCommand(w.stdin, map[string]any{"type": "extension_ui_response", "id": id, "confirmed": allow})
}

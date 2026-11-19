package workers

import (
	"errors"
	"time"
)

type ComputerRequest struct {
	ID      string    `json:"id"`
	Tool    string    `json:"tool"`
	Detail  string    `json:"detail"`
	Expires time.Time `json:"expires"`
}

type computerWorker interface {
	ComputerRequests() []ComputerRequest
	ReplyComputerRequest(string, bool) error
	ApplyComputerPolicy()
}

func (m *Manager) computerWorker(sessionID string) computerWorker {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, _ := m.workers[sessionID].(computerWorker)
	return w
}

func (m *Manager) ComputerRequests(sessionID string) []ComputerRequest {
	if w := m.computerWorker(sessionID); w != nil {
		return w.ComputerRequests()
	}
	return nil
}

func (m *Manager) ReplyComputerRequest(sessionID, id string, allow bool) error {
	if w := m.computerWorker(sessionID); w != nil {
		return w.ReplyComputerRequest(id, allow)
	}
	return errors.New("approval expired")
}

func (m *Manager) ApplyComputerPolicy(sessionID string) {
	if w := m.computerWorker(sessionID); w != nil {
		w.ApplyComputerPolicy()
	}
}

package workers

// LivePreview is a transient view of one worker's current reply.
type LivePreview struct {
	Content  string `json:"content"`
	Thinking string `json:"thinking,omitempty"`
	Phase    string `json:"phase,omitempty"`
	Done     bool   `json:"done"`
	Revision uint64 `json:"revision,omitempty"`
}

func (m *Manager) ChatPreview(sessionID string) (LivePreview, bool) {
	m.mu.Lock()
	worker, ok := m.workers[sessionID].(interface{ ChatPreview() (LivePreview, bool) })
	m.mu.Unlock()
	if !ok {
		return LivePreview{}, false
	}
	return worker.ChatPreview()
}

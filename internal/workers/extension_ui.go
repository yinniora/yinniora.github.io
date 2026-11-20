package workers

import (
	"errors"
	"time"
)

type ExtensionDialog struct {
	ID          string     `json:"id"`
	Method      string     `json:"method"`
	Title       string     `json:"title"`
	Message     string     `json:"message,omitempty"`
	Placeholder string     `json:"placeholder,omitempty"`
	Prefill     string     `json:"prefill,omitempty"`
	Options     []string   `json:"options,omitempty"`
	Questions   []Question `json:"questions,omitempty"`
	Expires     time.Time  `json:"expires"`
}

type Question struct {
	Question    string           `json:"question"`
	Header      string           `json:"header,omitempty"`
	MultiSelect bool             `json:"multiSelect,omitempty"`
	Options     []QuestionOption `json:"options"`
}

type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
	Default     bool   `json:"default,omitempty"`
}

type ExtensionNotice struct {
	ID      string `json:"id"`
	Message string `json:"message"`
	Kind    string `json:"kind,omitempty"`
}

type ExtensionUI struct {
	Dialogs []ExtensionDialog `json:"dialogs,omitempty"`
	Notices []ExtensionNotice `json:"notices,omitempty"`
}

type ExtensionAnswer struct {
	ID        string  `json:"id"`
	Cancelled bool    `json:"cancelled,omitempty"`
	Confirmed *bool   `json:"confirmed,omitempty"`
	Value     *string `json:"value,omitempty"`
	// Extend asks the worker to push the dialog's deadline out because the user
	// has started answering. It is not a response; nothing is sent to pi.
	Extend bool `json:"extend,omitempty"`
}

var ErrExtensionExpired = errors.New("Pi extension request expired")
var ErrExtensionAnswer = errors.New("invalid Pi extension answer")

type extensionUIWorker interface {
	ExtensionUI() ExtensionUI
	ReplyExtensionUI(ExtensionAnswer) error
}

func (m *Manager) extensionWorker(id string) extensionUIWorker {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, _ := m.workers[id].(extensionUIWorker)
	return w
}

func (m *Manager) ExtensionUI(id string) ExtensionUI {
	if w := m.extensionWorker(id); w != nil {
		return w.ExtensionUI()
	}
	return ExtensionUI{}
}

func (m *Manager) ReplyExtensionUI(id string, answer ExtensionAnswer) error {
	if w := m.extensionWorker(id); w != nil {
		return w.ReplyExtensionUI(answer)
	}
	return ErrExtensionExpired
}

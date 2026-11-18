package rpc

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"pi-web/internal/workers"
)

type pendingExtensionDialog struct {
	dialog workers.ExtensionDialog
	timer  *time.Timer
}

func (w *piRPCWorker) handleExtensionUI(line string) {
	var request struct {
		workers.ExtensionDialog
		Timeout    int64  `json:"timeout"`
		NotifyType string `json:"notifyType"`
	}
	if json.Unmarshal([]byte(line), &request) != nil || request.ID == "" || len(request.ID) > 200 {
		return
	}
	if request.Title == "YuGo Pi computer approval" {
		if w.computerMode != nil {
			w.handleComputerApproval(line)
		}
		return
	}
	if request.Method == "notify" {
		message := strings.TrimSpace(request.Message)
		if message == "" || len(message) > 8192 {
			return
		}
		w.mu.Lock()
		w.extensionNotices = append(w.extensionNotices, workers.ExtensionNotice{ID: request.ID, Message: message, Kind: request.NotifyType})
		if len(w.extensionNotices) > 8 {
			w.extensionNotices = w.extensionNotices[1:]
		}
		w.mu.Unlock()
		return
	}
	switch request.Method {
	case "confirm", "select", "input", "editor":
	default:
		return
	}
	cancel := workers.ExtensionAnswer{ID: request.ID, Cancelled: true}
	if len(line) > 128*1024 || len(request.Options) > 100 {
		_ = w.writeExtensionAnswer(cancel)
		return
	}
	timeout := 2 * time.Minute
	if request.Timeout > 0 && request.Timeout < timeout.Milliseconds() {
		timeout = time.Duration(request.Timeout) * time.Millisecond
	}
	request.Expires = time.Now().Add(timeout)
	w.mu.Lock()
	if w.extensionDialogs[request.ID] != nil {
		w.mu.Unlock()
		return
	}
	if len(w.extensionDialogs) >= 16 || w.extensionClosed {
		w.mu.Unlock()
		_ = w.writeExtensionAnswer(cancel)
		return
	}
	if w.extensionDialogs == nil {
		w.extensionDialogs = make(map[string]*pendingExtensionDialog)
	}
	pending := &pendingExtensionDialog{dialog: request.ExtensionDialog}
	pending.timer = time.AfterFunc(timeout, func() {
		w.mu.Lock()
		if w.extensionDialogs[request.ID] != pending {
			w.mu.Unlock()
			return
		}
		delete(w.extensionDialogs, request.ID)
		w.mu.Unlock()
		_ = w.writeExtensionAnswer(cancel)
	})
	w.extensionDialogs[request.ID] = pending
	w.mu.Unlock()
}

func (w *piRPCWorker) ExtensionUI() workers.ExtensionUI {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := workers.ExtensionUI{Notices: slices.Clone(w.extensionNotices)}
	for _, pending := range w.extensionDialogs {
		if time.Now().Before(pending.dialog.Expires) {
			out.Dialogs = append(out.Dialogs, pending.dialog)
		}
	}
	slices.SortFunc(out.Dialogs, func(a, b workers.ExtensionDialog) int { return a.Expires.Compare(b.Expires) })
	return out
}

func (w *piRPCWorker) ReplyExtensionUI(answer workers.ExtensionAnswer) error {
	w.mu.Lock()
	pending := w.extensionDialogs[answer.ID]
	if pending == nil || !time.Now().Before(pending.dialog.Expires) {
		w.mu.Unlock()
		return workers.ErrExtensionExpired
	}
	valid := answer.Cancelled
	if !answer.Cancelled {
		switch pending.dialog.Method {
		case "confirm":
			valid = answer.Confirmed != nil && answer.Value == nil
		case "select":
			valid = answer.Value != nil && answer.Confirmed == nil && slices.Contains(pending.dialog.Options, *answer.Value)
		default:
			valid = answer.Value != nil && answer.Confirmed == nil && len(*answer.Value) <= 64*1024
		}
	}
	if !valid {
		w.mu.Unlock()
		return workers.ErrExtensionAnswer
	}
	pending.timer.Stop()
	delete(w.extensionDialogs, answer.ID)
	w.mu.Unlock()
	return w.writeExtensionAnswer(answer)
}

func (w *piRPCWorker) writeExtensionAnswer(answer workers.ExtensionAnswer) error {
	cmd := map[string]any{"type": "extension_ui_response", "id": answer.ID}
	if answer.Cancelled {
		cmd["cancelled"] = true
	} else if answer.Confirmed != nil {
		cmd["confirmed"] = *answer.Confirmed
	} else if answer.Value != nil {
		cmd["value"] = *answer.Value
	}
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return WriteCommand(w.stdin, cmd)
}

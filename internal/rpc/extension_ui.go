package rpc

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"pi-web/internal/workers"
)

type pendingExtensionDialog struct {
	dialog   workers.ExtensionDialog
	timer    *time.Timer
	extended bool
}

const structuredQuestionTitle = "YuGo Pi structured questions"
const questionTimeoutReply = "timedOut"

func validQuestions(questions []workers.Question) bool {
	if len(questions) < 1 || len(questions) > 4 {
		return false
	}
	names := make(map[string]bool, len(questions))
	for _, question := range questions {
		if strings.TrimSpace(question.Question) == "" || names[question.Question] ||
			len(question.Options) < 2 || len(question.Options) > 4 {
			return false
		}
		names[question.Question] = true
		labels := make(map[string]bool, len(question.Options))
		defaults := 0
		for _, option := range question.Options {
			if strings.TrimSpace(option.Label) == "" || labels[option.Label] {
				return false
			}
			labels[option.Label] = true
			if option.Default {
				defaults++
			}
		}
		if !question.MultiSelect && defaults > 1 {
			return false
		}
	}
	return true
}

// maxCustomAnswer bounds one free-form answer. Options carry their own labels;
// this only caps the text a user types into the "something else" field.
const maxCustomAnswer = 2000

// validQuestionAnswer accepts what the picker can actually produce: option
// labels, a typed answer that is not an option, and an empty selection for a
// question the user chose to skip.
// extensionUIDefaultTimeout bounds how long an extension dialog stays open.
const extensionUIDefaultTimeout = 2 * time.Minute
const extensionQuestionAnswerTime = 5 * time.Minute

func validQuestionAnswer(value string, questions []workers.Question) bool {
	if len(value) > 64*1024 {
		return false
	}
	var selections [][]string
	if json.Unmarshal([]byte(value), &selections) != nil || len(selections) != len(questions) {
		return false
	}
	for index, selected := range selections {
		question := questions[index]
		// One slot per option plus one typed answer.
		if len(selected) > len(question.Options)+1 || (!question.MultiSelect && len(selected) > 1) {
			return false
		}
		seen := make(map[string]bool, len(selected))
		for _, entry := range selected {
			trimmed := strings.TrimSpace(entry)
			if trimmed == "" || len(entry) > maxCustomAnswer || seen[trimmed] {
				return false
			}
			seen[trimmed] = true
		}
	}
	return true
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
	if request.Title == computerPolicyTitle {
		if w.computerMode != nil && request.Method == "select" {
			mode := w.computerMode()
			_ = w.writeExtensionAnswer(workers.ExtensionAnswer{ID: request.ID, Value: &mode})
		}
		return
	}
	if request.Title == computerApprovalTitle {
		if w.computerMode != nil && request.Method == "confirm" {
			w.handleComputerApproval(request.ID, request.Message, request.Timeout)
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
	request.Questions = nil
	if request.Method == "input" && request.Title == structuredQuestionTitle {
		if json.Unmarshal([]byte(request.Placeholder), &request.Questions) != nil || !validQuestions(request.Questions) {
			_ = w.writeExtensionAnswer(cancel)
			return
		}
		request.Method = "question"
		request.Placeholder = ""
	}
	timeout := extensionUIDefaultTimeout
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
		if w.extensionDialogs[request.ID] != pending || time.Now().Before(pending.dialog.Expires) {
			w.mu.Unlock()
			return
		}
		delete(w.extensionDialogs, request.ID)
		w.mu.Unlock()
		answer := cancel
		if request.Method == "question" {
			value := questionTimeoutReply
			answer = workers.ExtensionAnswer{ID: request.ID, Value: &value}
		}
		_ = w.writeExtensionAnswer(answer)
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
	// "extend" is the user telling us they have started answering: push the
	// deadline out so reading and typing never race the timer.
	if answer.Extend {
		if pending.dialog.Method != "question" || answer.Value != nil || answer.Cancelled || answer.Confirmed != nil {
			w.mu.Unlock()
			return workers.ErrExtensionAnswer
		}
		if !pending.extended {
			pending.extended = true
			pending.dialog.Expires = time.Now().Add(extensionQuestionAnswerTime)
			pending.timer.Reset(extensionQuestionAnswerTime)
		}
		w.mu.Unlock()
		return nil
	}
	valid := answer.Cancelled
	if !answer.Cancelled {
		switch pending.dialog.Method {
		case "confirm":
			valid = answer.Confirmed != nil && answer.Value == nil
		case "select":
			valid = answer.Value != nil && answer.Confirmed == nil && slices.Contains(pending.dialog.Options, *answer.Value)
		case "question":
			valid = answer.Value != nil && answer.Confirmed == nil && validQuestionAnswer(*answer.Value, pending.dialog.Questions)
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

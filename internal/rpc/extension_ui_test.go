package rpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"pi-web/internal/workers"
)

func TestStructuredQuestionWaitsForValidatedUserAnswer(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}}
	defer w.Close()
	payload, err := json.Marshal(map[string]string{
		"type": "extension_ui_request", "id": "ask", "method": "input", "title": structuredQuestionTitle,
		"placeholder": `[{"question":"Scope","options":[{"label":"Local","default":true},{"label":"Remote"}]},{"question":"Files","multiSelect":true,"options":[{"label":"One"},{"label":"Two"}]}]`,
	})
	if err != nil {
		t.Fatal(err)
	}
	w.handleRPCLine(string(payload))
	dialogs := w.ExtensionUI().Dialogs
	if len(dialogs) != 1 || dialogs[0].Method != "question" || !dialogs[0].Questions[0].Options[0].Default ||
		sent.Len() != 0 || !w.Status().WaitingForInput {
		t.Fatalf("request did not stay pending: %+v", dialogs)
	}
	for _, value := range []string{`[["Local"]]`, `[["Local","Remote"],["One"]]`, `[["Local"],["One","One"]]`, `[[""],["One"]]`, questionTimeoutReply} {
		if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "ask", Value: &value}); !errors.Is(err, workers.ErrExtensionAnswer) {
			t.Errorf("answer %q: %v", value, err)
		}
	}
	// A typed answer that is not one of the options, and an explicit skip, are
	// both valid: the picker offers "something else" and "skip".
	for _, value := range []string{`[["A scope pi did not offer"],["One"]]`, `[["Local"],[]]`, `[["Local"],["One","also this"]]`} {
		if !validQuestionAnswer(value, dialogs[0].Questions) {
			t.Errorf("custom/skipped answer %q rejected", value)
		}
	}
	value := `[["Local"],["One","Two"]]`
	if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "ask", Value: &value}); err != nil {
		t.Fatal(err)
	}
	if sent.Len() == 0 || w.Status().WaitingForInput || len(w.ExtensionUI().Dialogs) != 0 {
		t.Fatal("valid user answer did not release the waiting turn")
	}
}

func TestExtensionDialogReplyValidatesChoiceAndCannotAcknowledgeGuard(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}, computerMode: func() string { return "ask" }}
	defer w.Close()
	w.handleRPCLine(`{"type":"extension_ui_request","id":"choose","method":"select","title":"Choose","options":["A","B"]}`)
	sendComputerApproval(t, w, "guard", "a")
	if dialogs := w.ExtensionUI().Dialogs; len(dialogs) != 1 || dialogs[0].ID != "choose" {
		t.Fatalf("generic dialogs: %+v", dialogs)
	}
	invalid := "C"
	if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "choose", Value: &invalid}); !errors.Is(err, workers.ErrExtensionAnswer) {
		t.Fatalf("invalid selection error = %v", err)
	}
	allow := true
	if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "guard", Confirmed: &allow}); !errors.Is(err, workers.ErrExtensionExpired) {
		t.Fatalf("generic reply tried to answer computer guard: %v", err)
	}
	valid := "B"
	if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "choose", Value: &valid}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sent.String(), `"value":"B"`) || len(w.ExtensionUI().Dialogs) != 0 {
		t.Fatalf("selection not resolved: %q", sent.String())
	}
	if err := w.ReplyExtensionUI(workers.ExtensionAnswer{ID: "choose", Value: &valid}); !errors.Is(err, workers.ErrExtensionExpired) {
		t.Fatalf("duplicate response accepted: %v", err)
	}
}

func sendComputerApproval(t *testing.T, w *piRPCWorker, id, digestChar string) {
	t.Helper()
	request, err := json.Marshal(map[string]string{
		"type": "extension_ui_request", "id": id, "method": "input", "title": computerApprovalTitle,
		"placeholder": `{"tool":"find_roots","digest":"` + strings.Repeat(digestChar, 64) + `"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	w.handleRPCLine(string(request))
}

func TestComputerPolicyChangeResolvesPendingAndOverridesEarlierRejection(t *testing.T) {
	var sent bytes.Buffer
	mode := "ask"
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}, computerMode: func() string { return mode }}
	sendComputerApproval(t, w, "first", "a")
	if len(w.ComputerRequests()) != 1 || !w.Status().WaitingForInput {
		t.Fatal("approval was not queued")
	}
	mode = "allow"
	w.ApplyComputerPolicy()
	if len(w.ComputerRequests()) != 0 || !strings.Contains(sent.String(), `"id":"first","type":"extension_ui_response","value":"approved"`) {
		t.Fatalf("pending action did not use the new policy: %s", &sent)
	}
	mode = "ask"
	sendComputerApproval(t, w, "denied", "a")
	if err := w.ReplyComputerRequest("denied", false); err != nil {
		t.Fatal(err)
	}
	sendComputerApproval(t, w, "repeated", "a")
	if len(w.ComputerRequests()) != 0 || !strings.Contains(sent.String(), `"id":"repeated","type":"extension_ui_response","value":"repeated"`) {
		t.Fatal("the declined action prompted again immediately")
	}
	sendComputerApproval(t, w, "different", "b")
	if len(w.ComputerRequests()) != 1 {
		t.Fatal("a distinct action did not receive its own approval")
	}
	if err := w.ReplyComputerRequest("different", true); err != nil {
		t.Fatal(err)
	}
	if err := w.ReplyComputerRequest("different", true); err == nil {
		t.Fatal("the same approval was accepted twice")
	}
	sendComputerApproval(t, w, "next-different", "b")
	if len(w.ComputerRequests()) != 1 {
		t.Fatal("allow once changed the general policy")
	}
	mode = "off"
	w.ApplyComputerPolicy()
	if w.Status().WaitingForInput || !strings.Contains(sent.String(), `"id":"next-different","type":"extension_ui_response","value":"off"`) {
		t.Fatal("off did not cancel the pending action")
	}
	if err := w.ReplyComputerRequest("next-different", true); err == nil {
		t.Fatal("off accepted a stale approval")
	}
	mode = "ask"
	w.ApplyComputerPolicy()
	sendComputerApproval(t, w, "declined-during-change", "a")
	mode = "allow"
	if err := w.ReplyComputerRequest("declined-during-change", false); err != nil ||
		!strings.Contains(sent.String(), `"id":"declined-during-change","type":"extension_ui_response","value":"declined"`) {
		t.Fatal("explicit decline was overridden by a concurrent policy update")
	}
	sendComputerApproval(t, w, "next", "a")
	if len(w.ExtensionUI().Dialogs) != 0 ||
		!strings.Contains(sent.String(), `"id":"next","type":"extension_ui_response","value":"approved"`) {
		t.Fatalf("current permission was not authoritative: %s", &sent)
	}
	mode = "off"
	sendComputerApproval(t, w, "disabled", "a")
	if !strings.Contains(sent.String(), `"id":"disabled","type":"extension_ui_response","value":"off"`) {
		t.Fatal("computer operation ran despite off policy")
	}
}

func TestExpiredAndClosedComputerRequestsCannotBeApproved(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}, computerMode: func() string { return "ask" }}
	sendComputerApproval(t, w, "expired", "a")
	pending := w.computerRequests["expired"]
	pending.Expires = time.Now().Add(-time.Second)
	w.computerRequests["expired"] = pending
	if err := w.ReplyComputerRequest("expired", true); err == nil || w.Status().WaitingForInput {
		t.Fatal("expired action still waits for approval")
	}
	sendComputerApproval(t, w, "closed", "b")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.ReplyComputerRequest("closed", true); err == nil || w.Status().WaitingForInput {
		t.Fatal("closed action still waits for approval")
	}
	if strings.Contains(sent.String(), `"value":"approved"`) {
		t.Fatal("expired action approved")
	}
}

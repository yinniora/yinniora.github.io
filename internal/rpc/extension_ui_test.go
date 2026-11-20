package rpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

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
	w.handleRPCLine(`{"type":"extension_ui_request","id":"guard","method":"confirm","title":"YuGo Pi computer approval","message":"{\"Tool\":\"fixture\",\"Detail\":\"test\"}"}`)
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

func TestComputerPolicyChangeResolvesPendingAndOverridesEarlierRejection(t *testing.T) {
	var sent bytes.Buffer
	mode := "ask"
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}, computerMode: func() string { return mode }}
	request := func(id string) {
		w.handleRPCLine(`{"type":"extension_ui_request","id":"` + id + `","method":"confirm","title":"YuGo Pi computer approval","message":"{\"tool\":\"find_roots\"}"}`)
	}
	request("first")
	if len(w.ComputerRequests()) != 1 {
		t.Fatal("approval was not queued")
	}
	mode = "allow"
	w.ApplyComputerPolicy()
	if len(w.ComputerRequests()) != 0 || !strings.Contains(sent.String(), `"confirmed":true,"id":"first"`) {
		t.Fatalf("pending action did not use the new policy: %s", &sent)
	}
	mode = "ask"
	request("denied")
	if err := w.ReplyComputerRequest("denied", false); err != nil {
		t.Fatal(err)
	}
	request("repeated")
	if len(w.ComputerRequests()) != 0 || !strings.Contains(sent.String(), `"confirmed":false,"id":"repeated"`) {
		t.Fatal("another action was prompted after a denial")
	}
	mode = "allow"
	w.ApplyComputerPolicy()
	mode = "ask"
	request("declined-during-change")
	mode = "allow"
	if err := w.ReplyComputerRequest("declined-during-change", false); err != nil ||
		!strings.Contains(sent.String(), `"confirmed":false,"id":"declined-during-change"`) {
		t.Fatal("explicit decline was overridden by a concurrent policy update")
	}
	request("next")
	w.handleRPCLine(`{"type":"extension_ui_request","id":"policy","method":"select","title":"YuGo Pi computer policy","options":["ask","allow","off"]}`)
	if len(w.ExtensionUI().Dialogs) != 0 ||
		!strings.Contains(sent.String(), `"confirmed":true,"id":"next"`) ||
		!strings.Contains(sent.String(), `"value":"allow"`) {
		t.Fatalf("current permission or internal policy lookup was not authoritative: %s", &sent)
	}
	mode = "off"
	request("disabled")
	if !strings.Contains(sent.String(), `"confirmed":false,"id":"disabled"`) {
		t.Fatal("computer operation ran despite off policy")
	}
}

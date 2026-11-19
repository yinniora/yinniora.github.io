package rpc

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"pi-web/internal/workers"
)

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

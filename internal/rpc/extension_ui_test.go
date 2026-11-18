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

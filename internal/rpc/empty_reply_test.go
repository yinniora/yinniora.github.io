package rpc

import (
	"bufio"
	"encoding/json"
	"io"
	"strconv"
	"testing"
	"time"

	"pi-web/internal/workers"
)

func TestEmptyFinalReplyContinuesOnce(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	w := &piRPCWorker{stdin: writer, pending: make(map[string]chan response)}
	w.status.State = workers.WorkerStateRunning
	empty := `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"output":0}}}`
	scan := bufio.NewScanner(reader)
	readPrompt := func() map[string]any {
		lines := make(chan string, 1)
		go func() {
			if scan.Scan() {
				lines <- scan.Text()
			}
			close(lines)
		}()
		select {
		case line := <-lines:
			var sent map[string]any
			if err := json.Unmarshal([]byte(line), &sent); err != nil {
				t.Fatal(err)
			}
			return sent
		case <-time.After(2 * time.Second):
			t.Fatal("no continue prompt was sent")
		}
		return nil
	}

	w.handleRPCLine(empty)
	w.handleRPCLine(`{"type":"agent_end","messages":[]}`)
	w.handleRPCLine(`{"type":"agent_settled"}`)
	if w.Status().State != workers.WorkerStateRunning {
		t.Fatalf("empty reply ended the task: %+v", w.Status())
	}
	sent := readPrompt()
	if sent["type"] != "prompt" || sent["message"] != EmptyReplyContinuePrompt {
		t.Fatalf("unexpected recovery command: %+v", sent)
	}
	w.handleRPCLine(`{"type":"response","id":` + strconv.Quote(sent["id"].(string)) + `,"success":true}`)
	w.handleRPCLine(`{"type":"agent_start"}`)

	// A second empty reply in the same task ends it so the user can choose.
	w.handleRPCLine(empty)
	w.handleRPCLine(`{"type":"agent_end","messages":[]}`)
	if w.Status().State != workers.WorkerStateIdle {
		t.Fatalf("second empty reply kept running: %+v", w.Status())
	}
}

func TestAbortedSettlementDoesNotContinueEmptyReply(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	w := &piRPCWorker{
		stdin:   writer,
		pending: make(map[string]chan response),
		status:  workers.WorkerStatus{State: workers.WorkerStateRunning},
	}
	w.handleRPCLine(`{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"output":0}}}`)
	w.handleRPCLine(`{"type":"agent_end","willRetry":false}`)
	w.handleRPCLine(`{"type":"agent_settled","aborted":true}`)
	if got := w.Status().State; got != workers.WorkerStateIdle || w.emptyRecoveries != 0 {
		t.Fatalf("aborted reply resumed: state=%s, recoveries=%d", got, w.emptyRecoveries)
	}
}

func TestEmptyFinalReplyNeedsNoContentAndNoOutput(t *testing.T) {
	for _, c := range []struct {
		stop        string
		blocks, out int
		want        bool
	}{{"stop", 0, 0, true}, {"stop", 1, 0, false}, {"stop", 0, 3, false}, {"aborted", 0, 0, false}, {"toolUse", 0, 0, false}} {
		if got := isEmptyFinalReply(c.stop, c.blocks, c.out); got != c.want {
			t.Fatalf("isEmptyFinalReply(%+v) = %v", c, got)
		}
	}
}

package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/workers"
)

type nopWriteCloser struct{ w io.Writer }

func (n nopWriteCloser) Write(p []byte) (int, error) { return n.w.Write(p) }
func (n nopWriteCloser) Close() error                { return nil }

func waitForPending(t *testing.T, w *piRPCWorker, id string) {
	t.Helper()
	for i := 0; i < 1000; i++ {
		w.mu.Lock()
		_, ok := w.pending[id]
		w.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("pending request %q never registered", id)
}

func TestPromptCompactsAfterMeasuredLengthStopEvenWhenPiArchivedIt(t *testing.T) {
	path := t.TempDir() + "/session.jsonl"
	fixture := `{"type":"session","version":3}
{"type":"message","id":"user","parentId":null,"message":{"role":"user","content":"task"}}
{"type":"message","id":"limited","parentId":"user","message":{"role":"assistant","model":"opus","provider":"local","content":[],"stopReason":"length","usage":{"totalTokens":124552,"output":1}}}
{"type":"context_edit","id":"omit","parentId":"limited","replacement":null,"targetId":"limited"}
{"type":"session_info","name":"diagnostic"}
`
	if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	limits := model{ID: "opus", Provider: "local", ContextWindow: 128000, MaxTokens: 32000}
	w := &piRPCWorker{stdin: writer, sessionPath: path, modelLimits: limits, autoCompaction: true, pending: make(map[string]chan response)}
	result := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		defer writer.Close()
		result <- w.Prompt(ctx, chat.Request{Message: "Resume this task"})
	}()
	scan := bufio.NewScanner(reader)
	for _, command := range []string{"compact", "prompt"} {
		if !scan.Scan() {
			t.Fatalf("expected %s: %v", command, scan.Err())
		}
		var sent map[string]any
		if err := json.Unmarshal(scan.Bytes(), &sent); err != nil || sent["type"] != command {
			t.Fatalf("expected %s, got %s", command, scan.Text())
		}
		if (command == "compact") != w.Status().Compacting {
			t.Fatalf("unexpected compaction state at %s: %+v", command, w.Status())
		}
		w.handleRPCLine(`{"type":"response","id":` + strconv.Quote(sent["id"].(string)) + `,"success":true}`)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(fixture+`{"type":"compaction","id":"new","parentId":"omit"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if needsCompaction(path, limits, chat.Request{}) {
		t.Fatal("old usage triggered compaction again after a saved compaction")
	}
}

func TestWorkerDirUsesSessionCWD(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/sess.jsonl"
	if err := os.WriteFile(path, []byte(`{"type":"session","cwd":`+strconv.Quote(dir)+`}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := workerDir(path); got != dir {
		t.Fatalf("workerDir = %q, want session cwd %q", got, dir)
	}
}

func TestWorkerDirFallsBackToTempWhenCWDMissing(t *testing.T) {
	path := t.TempDir() + "/sess.jsonl"
	if err := os.WriteFile(path, []byte(`{"type":"session","cwd":""}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := workerDir(path); got != detachedPiDir() {
		t.Fatalf("workerDir = %q, want detached dir %q", got, detachedPiDir())
	}
}

func TestStatusReportsRunningDuringRecentStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestStatusReturnsIdleAfterAgentEnd(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateRunning},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	w.handleRPCLine(`{"type":"agent_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle", got.State)
	}
}

func TestWorkerStaysRunningUntilPiSettles(t *testing.T) {
	w := &piRPCWorker{status: workers.WorkerStatus{State: workers.WorkerStateRunning}}
	w.handleRPCLine(`{"type":"agent_end","willRetry":true}`)
	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("retry was reported as finished: %v", got.State)
	}
	w.handleRPCLine(`{"type":"agent_end","willRetry":false}`)
	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("low-level run was reported as settled: %v", got.State)
	}
	w.handleRPCLine(`{"type":"agent_settled","aborted":false}`)
	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("settled run is still marked busy: %v", got.State)
	}
}

func TestWorkerCancelsAutomaticRetry(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{
		stdin:         nopWriteCloser{w: &sent},
		status:        workers.WorkerStatus{State: workers.WorkerStateRunning},
		streamPreview: &streamPreviewAccumulator{},
	}
	w.handleRPCLine(`{"type":"message_end","message":{"role":"assistant","provider":"key-one","model":"model-x","stopReason":"error","errorMessage":"503 {\"error\":{\"type\":\"model_not_found\"}}"}}`)
	w.handleRPCLine(`{"type":"auto_retry_start","attempt":1}`)
	w.handleRPCLine(`{"type":"agent_end"}`)
	if sent.String() != "{\"type\":\"abort_retry\"}\n" || w.Status().State != workers.WorkerStateIdle {
		t.Fatalf("unexpected retry command or state: %q, %#v", sent.String(), w.Status())
	}
}

func TestWorkerKeepsRetryingTransientNetworkErrors(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{
		stdin:  nopWriteCloser{w: &sent},
		status: workers.WorkerStatus{State: workers.WorkerStateRunning},
	}
	w.handleRPCLine(`{"type":"auto_retry_start","attempt":1,"errorMessage":"Connection error.: Client network socket disconnected before secure TLS connection was established (ECONNRESET)"}`)
	if sent.Len() != 0 {
		t.Fatalf("transient network error retry was cancelled: %q", sent.String())
	}
	w.handleRPCLine(`{"type":"auto_retry_start","attempt":1,"errorMessage":"503 {\"error\":{\"type\":\"model_not_found\"}}"}`)
	if sent.String() != "{\"type\":\"abort_retry\"}\n" {
		t.Fatalf("provider rejection retry was not cancelled: %q", sent.String())
	}
	for _, message := range []string{"fetch failed", "socket hang up", "read ETIMEDOUT", "UND_ERR_SOCKET"} {
		if !isTransientTransportError(message) {
			t.Fatalf("%q should be transient", message)
		}
	}
	for _, message := range []string{"", "429 rate limited", "500 internal error", "403 quota exceeded"} {
		if isTransientTransportError(message) {
			t.Fatalf("%q should not be transient", message)
		}
	}
}

func TestWorkerRetriesTimeoutsAndOverloadButNotBillingOrUserAbort(t *testing.T) {
	for _, message := range []string{
		"Request timed out.",
		"503 Service Unavailable",
		"429 rate limited",
		"500 internal error",
		"Connection error.: Client network socket disconnected before secure TLS connection was established (ECONNRESET)",
	} {
		if !isAutoRetryAllowed(message) {
			t.Errorf("%q should be retried", message)
		}
	}
	for _, message := range []string{
		"insufficient balance",
		"Insufficient credit",
		"quota exceeded",
		"401 Unauthorized",
		"invalid api key",
		`503 {"error":{"type":"model_not_found"}}`,
		"Request aborted by user",
		"",
	} {
		if isAutoRetryAllowed(message) {
			t.Errorf("%q must not be retried", message)
		}
	}

	var sent bytes.Buffer
	w := &piRPCWorker{
		stdin:         nopWriteCloser{w: &sent},
		status:        workers.WorkerStatus{State: workers.WorkerStateRunning},
		streamPreview: &streamPreviewAccumulator{},
		streamSink:    func(StreamPreview) {},
	}
	w.handleRPCLine(`{"type":"auto_retry_start","attempt":2,"maxAttempts":5,"errorMessage":"Request timed out."}`)
	if sent.Len() != 0 {
		t.Fatalf("a timeout was cancelled instead of retried: %q", sent.String())
	}
	preview, ok := w.ChatPreview()
	if !ok || preview.Phase != "retrying" || preview.RetryAttempt != 2 || preview.RetryLimit != 5 {
		t.Fatalf("retry was not recorded in progress: %+v", preview)
	}
	if w.Status().Error != "" {
		t.Fatalf("a retried turn must not report an error: %q", w.Status().Error)
	}
	w.handleRPCLine(`{"type":"auto_retry_end","success":true}`)
	if preview, _ := w.ChatPreview(); preview.Phase == "retrying" {
		t.Fatalf("retry notice outlived the successful attempt: %+v", preview)
	}

	sent.Reset()
	w.handleRPCLine(`{"type":"auto_retry_start","attempt":1,"errorMessage":"insufficient balance"}`)
	if sent.String() != "{\"type\":\"abort_retry\"}\n" {
		t.Fatalf("a billing failure must not be retried: %q", sent.String())
	}
}

func TestStatusDoesNotStayRunningAfterStreamActivityExpires(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	time.Sleep(2200 * time.Millisecond)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle after stream activity expires", got.State)
	}
}

func TestHandleRPCLineTracksTurnEndAsStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"turn_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestHandleRPCLineEmitsStreamPreviewCallbacks(t *testing.T) {
	var previews []StreamPreview
	w := &piRPCWorker{
		status:        workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:       make(map[string]chan response),
		streamSink:    func(preview StreamPreview) { previews = append(previews, preview) },
		streamPreview: &streamPreviewAccumulator{},
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hel"}}`)
	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"lo"}}`)

	if len(previews) != 2 {
		t.Fatalf("previews = %d, want 2", len(previews))
	}
	if previews[0].Content != "hel" || previews[0].Done {
		t.Fatalf("first preview = %+v", previews[0])
	}
	if previews[1].Content != "hello" || previews[1].Done {
		t.Fatalf("second preview = %+v", previews[1])
	}
}

func TestHandleRPCLineEmitsDonePreviewOnAgentEnd(t *testing.T) {
	var previews []StreamPreview
	w := &piRPCWorker{
		status:        workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:       make(map[string]chan response),
		streamSink:    func(preview StreamPreview) { previews = append(previews, preview) },
		streamPreview: &streamPreviewAccumulator{},
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	w.handleRPCLine(`{"type":"agent_end"}`)

	if len(previews) != 2 {
		t.Fatalf("previews = %d, want 2", len(previews))
	}
	if previews[1].Content != "hello" || !previews[1].Done {
		t.Fatalf("done preview = %+v", previews[1])
	}
}

func TestHandleRPCLineTracksMessageEndAsStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestHandleRPCLineStreamsNativeCompactionUntilSettled(t *testing.T) {
	var previews []StreamPreview
	w := &piRPCWorker{
		status:        workers.WorkerStatus{State: workers.WorkerStateRunning},
		streamPreview: &streamPreviewAccumulator{},
		streamSink:    func(preview StreamPreview) { previews = append(previews, preview) },
	}
	w.handleRPCLine(`{"type":"agent_end","willRetry":false}`)
	w.handleRPCLine(`{"type":"compaction_start","reason":"overflow"}`)
	snapshot, ok := w.ChatPreview()
	if !ok || snapshot.Phase != "compacting" || w.Status().State != workers.WorkerStateRunning {
		t.Fatalf("compaction snapshot = %+v, ok = %v, status = %+v", snapshot, ok, w.Status())
	}
	w.handleRPCLine(`{"type":"compaction_end","reason":"overflow","willRetry":true}`)
	w.handleRPCLine(`{"type":"agent_settled"}`)
	if len(previews) != 3 || previews[0].Phase != "compacting" || previews[1].Phase != "working" || !previews[2].Done {
		t.Fatalf("compaction previews = %+v", previews)
	}
}

func TestGetCommandsReturnsCachedWithoutRPC(t *testing.T) {
	w := &piRPCWorker{
		pending:        make(map[string]chan response),
		commands:       []workers.SlashCommand{{Name: "skill:memory", Source: "skill"}},
		commandsCached: true,
	}
	// stdin is nil: the cache path must not attempt any RPC write.
	got, err := w.GetCommands(context.Background())
	if err != nil {
		t.Fatalf("GetCommands error: %v", err)
	}
	if len(got) != 1 || got[0].Name != "skill:memory" {
		t.Fatalf("got = %#v", got)
	}
}

func TestGetCommandsParsesResponseAndCaches(t *testing.T) {
	var buf bytes.Buffer
	w := &piRPCWorker{
		stdin:   nopWriteCloser{&buf},
		pending: make(map[string]chan response),
	}

	type result struct {
		cmds []workers.SlashCommand
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		cmds, err := w.GetCommands(context.Background())
		resCh <- result{cmds, err}
	}()

	waitForPending(t, w, "req-1")
	w.handleRPCLine(`{"type":"response","id":"req-1","command":"get_commands","success":true,"data":{"commands":[{"name":"skill:memory","description":"mem","source":"skill"},{"name":"btw","description":"side chat","source":"extension"}]}}`)

	got := <-resCh
	if got.err != nil {
		t.Fatalf("GetCommands error: %v", got.err)
	}
	if len(got.cmds) != 2 {
		t.Fatalf("commands = %#v", got.cmds)
	}
	if got.cmds[0].Name != "skill:memory" || got.cmds[0].Source != "skill" || got.cmds[0].Description != "mem" {
		t.Fatalf("first command = %#v", got.cmds[0])
	}

	// Second call must hit the cache: no further RPC write to stdin.
	buf.Reset()
	cached, err := w.GetCommands(context.Background())
	if err != nil {
		t.Fatalf("cached GetCommands error: %v", err)
	}
	if len(cached) != 2 {
		t.Fatalf("cached commands = %#v", cached)
	}
	if buf.Len() != 0 {
		t.Fatalf("cache hit wrote to stdin: %q", buf.String())
	}
}

func TestGetStateUsesPiThinkingLevelsForEachModel(t *testing.T) {
	var sent bytes.Buffer
	w := &piRPCWorker{stdin: nopWriteCloser{&sent}, pending: make(map[string]chan response)}
	checkState := func(stateID, model, probeID string, levels []string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		done := make(chan workers.WorkerStatus, 1)
		go func() {
			state, _ := w.GetState(ctx)
			done <- state
		}()
		waitForPending(t, w, stateID)
		w.handleRPCLine(`{"type":"response","id":"` + stateID + `","success":true,"data":{"thinkingLevel":"off","model":{"id":"` + model + `","provider":"fixture"}}}`)
		if probeID != "" {
			waitForPending(t, w, probeID)
			list := `["` + strings.Join(levels, `","`) + `"]`
			w.handleRPCLine(`{"type":"response","id":"` + probeID + `","success":true,"data":{"levels":` + list + `}}`)
		}
		state := <-done
		if state.Model != model || state.ModelProvider != "fixture" || !slices.Equal(state.ThinkingLevels, levels) {
			t.Fatalf("state = %+v, want model %s with levels %v", state, model, levels)
		}
	}
	checkState("req-1", "adjustable", "req-2", []string{"off", "low", "max"})
	checkState("req-3", "adjustable", "", []string{"off", "low", "max"})
	checkState("req-4", "fixed", "req-5", []string{"off"})
	if count := strings.Count(sent.String(), `"type":"get_available_thinking_levels"`); count != 2 {
		t.Fatalf("probed levels %d times, want one query per model", count)
	}
}

func TestHandleRPCLineIgnoresMalformedJSON(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{not-json}`)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle", got.State)
	}
}

func TestHandleRPCLineTracksThinkingAndTextStreamEvents(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	for _, line := range []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_end"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"done"}}`,
	} {
		w.handleRPCLine(line)
		if got := w.Status(); got.State != workers.WorkerStateRunning {
			t.Fatalf("line %s => status = %q, want running", strings.TrimSpace(line), got.State)
		}
	}
}

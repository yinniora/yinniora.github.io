package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"pi-web/internal/workers"
)

// syncRecorder wraps httptest.ResponseRecorder so the handler goroutine's
// writes and the test goroutine's reads of the body do not race under -race.
type syncRecorder struct {
	*httptest.ResponseRecorder
	mu  sync.Mutex
	buf bytes.Buffer
}

func newSyncRecorder() *syncRecorder {
	return &syncRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (s *syncRecorder) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncRecorder) body() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func waitFor(t *testing.T, rec *syncRecorder, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.body(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %q in body:\n%s", want, rec.body())
}

func TestHandleEventsSendsStatusSnapshotForAllSubscribers(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   map[string]struct{}{"a.jsonl": {}, "b.jsonl": {}},
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()

	done := make(chan struct{})
	go func() {
		s.handleEvents(w, req)
		close(done)
	}()

	// Wait for the snapshot to be written, then close.
	waitFor(t, w, "event: status-snapshot")
	cancel()
	<-done

	body := w.body()
	if !strings.Contains(body, "event: status-snapshot") {
		t.Fatalf("missing snapshot event header in body:\n%s", body)
	}
	if !strings.Contains(body, `"a.jsonl"`) || !strings.Contains(body, `"b.jsonl"`) {
		t.Fatalf("snapshot did not include both ids:\n%s", body)
	}
}

func TestHandleEventsSendsCurrentRunningSendModeOnReconnect(t *testing.T) {
	s := &Server{db: newSettingsTestDB(t)}
	checkMode := func(mode string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
		ctx, cancel := context.WithCancel(req.Context())
		defer cancel()
		w := newSyncRecorder()
		done := make(chan struct{})
		go func() {
			s.handleEvents(w, req.WithContext(ctx))
			close(done)
		}()

		waitFor(t, w, "event: settings\ndata: {\"settings\":{\""+settingChatRunningSendMode+"\":\""+mode+"\"}}\n\n")
		cancel()
		<-done
	}
	checkMode("steer")

	req := httptest.NewRequest(http.MethodPost, "/api/settings", strings.NewReader(
		`{"settings":{"`+settingChatRunningSendMode+`":"queue"}}`,
	))
	w := httptest.NewRecorder()
	s.handleSaveSettings(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("save running send mode: status %d, body %s", w.Code, w.Body.String())
	}
	checkMode("queue")
}

func TestHandleEventsForwardsNamedDeltaEvents(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()

	done := make(chan struct{})
	go func() {
		s.handleEvents(w, req)
		close(done)
	}()

	// Wait for the initial :ok, then push a delta and a legacy reload.
	waitFor(t, w, ":ok")
	s.broadcast(globalSessID, "event: status-delta\ndata: {\"id\":\"x\",\"running\":true}")
	s.broadcast(globalSessID, "new-session")
	waitFor(t, w, "event: status-delta")
	waitFor(t, w, "data: new-session")
	cancel()
	<-done

	body := w.body()
	if !strings.Contains(body, "event: status-delta\ndata: {\"id\":\"x\",\"running\":true}") {
		t.Fatalf("expected named delta passthrough, got:\n%s", body)
	}
	if !strings.Contains(body, "data: new-session") {
		t.Fatalf("expected legacy plain-data passthrough, got:\n%s", body)
	}
}

func TestHandleEventsCoalescesTextAndDiscardsPendingOnDetach(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := &Server{}
		req := httptest.NewRequest(http.MethodGet, "/events?id=session.jsonl", nil)
		ctx, cancel := context.WithCancel(req.Context())
		defer cancel()
		w := newSyncRecorder()
		done := make(chan struct{})
		go func() {
			s.handleEvents(w, req.WithContext(ctx))
			close(done)
		}()
		synctest.Wait()

		preview := workers.LivePreview{Phase: "thinking", MessageTimestamp: 1}
		for revision, thought := range []string{"initial", "interim", "latest"} {
			preview.Revision, preview.Thinking = uint64(revision+1), thought
			s.BroadcastChatPreview("session.jsonl", preview)
			synctest.Wait()
		}
		if body := w.body(); strings.Count(body, "event: chat-preview") != 1 || !strings.Contains(body, `"thinking":"initial"`) {
			t.Fatalf("first event was not immediate or additional events were sent early: %s", body)
		}
		time.Sleep(chatPreviewInterval) // Virtual time inside synctest.
		synctest.Wait()
		if body := w.body(); strings.Count(body, "event: chat-preview") != 2 || !strings.Contains(body, `"thinking":"latest"`) {
			t.Fatalf("latest preview was not sent after the deadline: %s", body)
		}

		preview.Revision, preview.Thinking = 4, "pending after close"
		s.BroadcastChatPreview("session.jsonl", preview)
		synctest.Wait()
		cancel()
		<-done
		if body := w.body(); strings.Contains(body, "pending after close") {
			t.Fatalf("unsubscribed client received pending preview: %s", body)
		}
	})
}

func TestRecordModTimeBroadcastsReloadForKnownZeroModTime(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		clients:     make([]*sseClient, 0),
		fileMod:     map[string]time.Time{"fresh.jsonl": {}},
		lastKnown:   make(map[string]struct{}),
		now:         func() time.Time { return time.Date(2026, 5, 8, 11, 0, 1, 0, time.UTC) },
	}
	client := s.addClient("fresh.jsonl")

	s.recordModTime("fresh.jsonl", time.Date(2026, 5, 8, 11, 0, 0, 0, time.UTC))

	select {
	case got := <-client.ch:
		if got != "reload" {
			t.Fatalf("event = %q, want reload", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for reload")
	}
}

func TestChatPreviewBatchKeepsLatestTextAtDeadline(t *testing.T) {
	var batch chatPreviewBatch
	var emitted []pendingChatPreview
	emit := func(snapshot pendingChatPreview) { emitted = append(emitted, snapshot) }
	start := time.Now()
	base := workers.LivePreview{Phase: "thinking", MessageTimestamp: 14, Revision: 10, Thinking: "a"}
	if wait := batch.offer(start, pendingChatPreview{snapshot: base}, emit); wait != 0 {
		t.Fatalf("initial preview delayed by %v", wait)
	}
	base.Revision, base.Thinking = 11, "ab"
	if wait := batch.offer(start.Add(5*time.Millisecond), pendingChatPreview{snapshot: base}, emit); wait != 95*time.Millisecond {
		t.Fatalf("first delta wait = %v", wait)
	}
	base.Revision, base.Thinking = 12, "abc"
	if wait := batch.offer(start.Add(40*time.Millisecond), pendingChatPreview{snapshot: base}, emit); wait != 60*time.Millisecond {
		t.Fatalf("second delta wait = %v", wait)
	}
	if len(emitted) != 1 {
		t.Fatalf("should emit only the initial preview, got %v", emitted)
	}
	batch.flush(start.Add(chatPreviewInterval), emit)
	batch.flush(start.Add(2*chatPreviewInterval), emit)
	if len(emitted) != 2 || emitted[1].snapshot.Thinking != "abc" {
		t.Fatalf("expected exactly the latest thought after the deadline, got %v", emitted)
	}
}

func TestChatPreviewBatchFlushesBeforeStatusChangesAndCompletion(t *testing.T) {
	var batch chatPreviewBatch
	var emitted []pendingChatPreview
	emit := func(snapshot pendingChatPreview) { emitted = append(emitted, snapshot) }
	start := time.Now()
	think := workers.LivePreview{Phase: "thinking", MessageTimestamp: 14, Revision: 10, Thinking: "a"}
	batch.offer(start, pendingChatPreview{snapshot: think}, emit)
	think.Revision, think.Thinking = 12, "abc"
	batch.offer(start.Add(time.Millisecond), pendingChatPreview{snapshot: think}, emit)
	stale := think
	stale.Revision, stale.Thinking = 11, "ab"
	batch.offer(start.Add(2*time.Millisecond), pendingChatPreview{snapshot: stale}, emit)
	phaseChanges := []workers.LivePreview{
		{Phase: "tool", ToolName: "read", Revision: 13},
		{Phase: "retrying", RetryAttempt: 1, RetryLimit: 2, Revision: 14},
		{Phase: "retrying", RetryAttempt: 2, RetryLimit: 2, Revision: 15},
		{Done: true, Revision: 16},
	}
	for _, snapshot := range phaseChanges {
		if wait := batch.offer(start.Add(3*time.Millisecond), pendingChatPreview{snapshot: snapshot}, emit); wait != 0 {
			t.Fatalf("status preview %+v delayed by %v", snapshot, wait)
		}
	}
	batch.flush(start.Add(chatPreviewInterval), emit)
	if len(emitted) != 6 || emitted[1].snapshot.Thinking != "abc" {
		t.Fatalf("should flush the newest thought and each status, got %v", emitted)
	}
	for idx, snapshot := range phaseChanges {
		if emitted[idx+2].snapshot != snapshot {
			t.Fatalf("emitted preview %+v, want %+v", emitted[idx+2], snapshot)
		}
	}
}

func TestChatPreviewBatchDoesNotLoseReloadWhenOldDoneIsDropped(t *testing.T) {
	var batch chatPreviewBatch
	var emitted []pendingChatPreview
	emit := func(snapshot pendingChatPreview) { emitted = append(emitted, snapshot) }
	start := time.Now()
	reply := workers.LivePreview{Phase: "reply", MessageTimestamp: 19, Revision: 12, Content: "new"}
	batch.offer(start, pendingChatPreview{snapshot: reply}, emit)
	reply.Revision, reply.Content = 13, "new reply"
	batch.offer(start.Add(time.Millisecond), pendingChatPreview{snapshot: reply}, emit)
	dropped := pendingChatPreview{snapshot: workers.LivePreview{Done: true, Revision: 11}}
	batch.offer(start.Add(2*time.Millisecond), dropped, emit)
	batch.flush(start.Add(chatPreviewInterval), emit)
	if len(emitted) != 2 || emitted[1].snapshot != reply || !emitted[1].reload {
		t.Fatalf("expected newest text alongside the missed reload, got %v", emitted)
	}
}

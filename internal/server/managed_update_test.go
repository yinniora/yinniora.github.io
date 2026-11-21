package server

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pi-web/internal/auth"
	"pi-web/internal/chat"
	"pi-web/internal/workers"
)

const updateRequestBody = `{"version":"0.1.0-yugo.61"}`

func managedUpdateRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, "http://localhost:31415"+path, strings.NewReader(body))
	r.RemoteAddr = "[::1]:37201"
	r.Header.Set("Authorization", "Bearer local-test-token")
	return r
}

func TestManagedUpdateRequiresAuthenticatedLocalDesktop(t *testing.T) {
	for _, tc := range []struct {
		name, token string
		alter       func(*http.Request) *http.Request
		want        int
	}{
		{"local", "local-test-token", func(r *http.Request) *http.Request { return r }, 200},
		{"without local authentication", "", func(r *http.Request) *http.Request { return r }, 403},
		{"missing credentials", "local-test-token", func(r *http.Request) *http.Request {
			r.Header.Del("Authorization")
			return r
		}, 401},
		{"nonlocal peer", "local-test-token", func(r *http.Request) *http.Request {
			r.RemoteAddr = "100.64.0.1:37201"
			return r
		}, 403},
		{"nonlocal host", "local-test-token", func(r *http.Request) *http.Request {
			r.Host = "host.example.test"
			return r
		}, 403},
		{"paired device", "local-test-token", func(r *http.Request) *http.Request {
			return auth.WithApprovedDevice(r, "other-device")
		}, 403},
		{"cross-origin form", "local-test-token", func(r *http.Request) *http.Request {
			r.Header.Set("Origin", "https://outside.example.test")
			return r
		}, 403},
		{"get", "local-test-token", func(r *http.Request) *http.Request {
			r.Method = http.MethodGet
			return r
		}, 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := &Server{auth: auth.New(tc.token), managedUpdate: func(_ context.Context, _ string) (ManagedUpdateResult, error) {
				calls++
				return ManagedUpdateResult{NeedsRestart: true}, nil
			}}
			r := tc.alter(managedUpdateRequest(http.MethodPost, "/api/yugo-update", updateRequestBody))
			w := httptest.NewRecorder()
			s.auth.Wrap(s.handleManagedUpdate)(w, r)
			if w.Code != tc.want || (calls == 1) != (tc.want == http.StatusOK) {
				t.Fatalf("status=%d, calls=%d, body=%s", w.Code, calls, w.Body.String())
			}
		})
	}
}

func TestManagedRestartPreservesStagedUpdateAfterBusyOrFailedCommit(t *testing.T) {
	manager := workers.NewManagerWithTTL(nil, 0)
	t.Cleanup(func() { _ = manager.Close() })
	stages, attempts := 0, 0
	s := &Server{
		auth: auth.New("local-test-token"), chatSender: manager,
		managedUpdate: func(_ context.Context, version string) (ManagedUpdateResult, error) {
			stages++
			return ManagedUpdateResult{Version: version, NeedsRestart: true, Mode: "backend"}, nil
		},
		managedRestart: func() error {
			attempts++
			if err := manager.Send(context.Background(), "reply", "/tmp/reply", chat.Request{Message: "hello"}); !errors.Is(err, workers.ErrRestarting) {
				t.Errorf("send after restart commit returned %v", err)
			}
			if attempts == 1 {
				return errors.New("restart helper could not start")
			}
			return nil
		},
	}
	post := func(path, body string, want int) string {
		t.Helper()
		w := httptest.NewRecorder()
		handler := s.handleManagedUpdate
		if strings.HasSuffix(path, "/restart") {
			handler = s.handleManagedRestart
		}
		s.auth.Wrap(handler)(w, managedUpdateRequest(http.MethodPost, path, body))
		if w.Code != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, w.Code, want, w.Body.String())
		}
		return w.Body.String()
	}
	post("/api/yugo-update/restart", "", http.StatusConflict)
	finish, accepted := s.beginManagedWork()
	if !accepted {
		t.Fatal("expected chat admission before restart")
	}
	if body := post("/api/yugo-update", updateRequestBody, http.StatusOK); !strings.Contains(body, `"needsRestart":true`) {
		t.Fatalf("stage result does not offer restart: %s", body)
	}
	post("/api/yugo-update", updateRequestBody, http.StatusOK)
	post("/api/yugo-update", `{"version":"0.1.0-yugo.62"}`, http.StatusConflict)
	post("/api/yugo-update/restart", "", http.StatusConflict)
	finish()
	post("/api/yugo-update/restart", "", http.StatusInternalServerError)
	finish, accepted = s.beginManagedWork()
	if !accepted {
		t.Fatal("failed restart blocked subsequent chat")
	}
	finish()
	post("/api/yugo-update/restart", "", http.StatusOK)
	post("/api/yugo-update/restart", "", http.StatusConflict)
	if finish, accepted := s.beginManagedWork(); accepted {
		finish()
		t.Error("successful restart allowed new chat")
	}
	if stages != 1 || attempts != 2 {
		t.Errorf("staged %d times, restarted %d times", stages, attempts)
	}
}

func TestManagedUpdateRejectsConcurrentStageAndRestart(t *testing.T) {
	arrived := make(chan struct{})
	continueStage := make(chan struct{})
	manager := workers.NewManagerWithTTL(nil, 0)
	t.Cleanup(func() { _ = manager.Close() })
	s := &Server{
		auth: auth.New("local-test-token"), chatSender: manager,
		managedUpdate: func(_ context.Context, _ string) (ManagedUpdateResult, error) {
			close(arrived)
			<-continueStage
			return ManagedUpdateResult{NeedsRestart: true}, nil
		},
		managedRestart: func() error { return nil },
	}
	call := func(handler http.HandlerFunc, path, body string) int {
		w := httptest.NewRecorder()
		s.auth.Wrap(handler)(w, managedUpdateRequest(http.MethodPost, path, body))
		return w.Code
	}
	done := make(chan int, 1)
	go func() { done <- call(s.handleManagedUpdate, "/api/yugo-update", updateRequestBody) }()
	<-arrived
	if status := call(s.handleManagedUpdate, "/api/yugo-update", updateRequestBody); status != 409 {
		t.Errorf("concurrent stage status=%d", status)
	}
	if status := call(s.handleManagedRestart, "/api/yugo-update/restart", ""); status != 409 {
		t.Errorf("restart during stage status=%d", status)
	}
	close(continueStage)
	if status := <-done; status != 200 {
		t.Errorf("original stage status=%d", status)
	}
}

func TestManagedRestartCanRestageAfterRollback(t *testing.T) {
	manager := workers.NewManagerWithTTL(nil, 0)
	t.Cleanup(func() { _ = manager.Close() })
	stages := 0
	s := &Server{
		auth: auth.New("local-test-token"), chatSender: manager,
		managedUpdate: func(_ context.Context, _ string) (ManagedUpdateResult, error) {
			stages++
			return ManagedUpdateResult{NeedsRestart: true}, nil
		},
		managedRestart: func() error { return ErrManagedUpdateRestage },
	}
	stage := func() {
		t.Helper()
		w := httptest.NewRecorder()
		s.auth.Wrap(s.handleManagedUpdate)(w, managedUpdateRequest(http.MethodPost, "/api/yugo-update", updateRequestBody))
		if w.Code != 200 {
			t.Fatalf("stage status=%d body=%s", w.Code, w.Body.String())
		}
	}
	stage()
	w := httptest.NewRecorder()
	s.auth.Wrap(s.handleManagedRestart)(w, managedUpdateRequest(http.MethodPost, "/api/yugo-update/restart", ""))
	if w.Code != 500 || !strings.Contains(w.Body.String(), `"restage":true`) {
		t.Fatalf("rollback status=%d body=%s", w.Code, w.Body.String())
	}
	stage()
	if stages != 2 {
		t.Errorf("expected to stage again after rollback, calls=%d", stages)
	}
}

type managedPendingSender struct {
	*workers.Manager
	acknowledge <-chan struct{}
}

func (s managedPendingSender) Send(context.Context, string, string, chat.Request) error {
	<-s.acknowledge
	return nil
}

func TestManagedRestartWaitsForChatAcknowledgementAndPreservesQueue(t *testing.T) {
	manager := workers.NewManagerWithTTL(nil, 0)
	t.Cleanup(func() { _ = manager.Close() })
	acknowledge := make(chan struct{})
	s, id := newQueueServer(t)
	s.auth = auth.New("local-test-token")
	s.chatSender = managedPendingSender{Manager: manager, acknowledge: acknowledge}
	s.managedUpdateState.pending = ManagedUpdateResult{NeedsRestart: true, Version: "0.1.0-yugo.61"}
	s.managedRestart = func() error { return nil }
	item, err := s.chatQueue.Add(id, "keep this", "keep this")
	if err != nil {
		t.Fatal(err)
	}
	submit := func() int {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		_ = form.WriteField("message", "pending reply")
		_ = form.Close()
		r := httptest.NewRequest(http.MethodPost, "/api/chat?id="+id, &body)
		r.Header.Set("Content-Type", form.FormDataContentType())
		w := httptest.NewRecorder()
		s.handleChat(w, r)
		return w.Code
	}
	restart := func() int {
		w := httptest.NewRecorder()
		s.auth.Wrap(s.handleManagedRestart)(w, managedUpdateRequest(http.MethodPost, "/api/yugo-update/restart", ""))
		return w.Code
	}
	if status := submit(); status != http.StatusAccepted {
		t.Errorf("chat status=%d", status)
	}
	if status := restart(); status != http.StatusConflict {
		t.Errorf("restart with unacknowledged chat status=%d", status)
	}
	close(acknowledge)
	s.wg.Wait()
	if status := restart(); status != http.StatusOK {
		t.Fatalf("restart after chat acknowledgement status=%d", status)
	}
	if status := submit(); status != http.StatusConflict {
		t.Errorf("chat after restart commit status=%d", status)
	}
	if err := s.sendQueued(context.Background(), "", item, true); !errors.Is(err, workers.ErrRestarting) {
		t.Errorf("queue dispatch after restart commit: %v", err)
	}
	if snapshot, err := s.chatQueue.List(id); err != nil || len(snapshot.Items) != 1 || snapshot.Paused {
		t.Errorf("queue after restart commit: %+v, %v", snapshot, err)
	}
}

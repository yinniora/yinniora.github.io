package workers

import (
	"context"
	"pi-web/internal/chat"
	"testing"
)

func TestRetiredSessionCannotRecreateWorker(t *testing.T) {
	count := 0
	m := NewManagerWithTTL(func(id, path string) (ChatWorker, error) { count++; return &fakeChatWorker{}, nil }, 0)
	defer m.Close()
	if err := m.EnsureWorker(context.Background(), "a.jsonl", "/tmp/a.jsonl"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RetireIdle("a.jsonl"); err != nil {
		t.Fatal(err)
	}
	if err := m.Send(context.Background(), "a.jsonl", "/tmp/a.jsonl", chat.Request{Message: "test"}); err == nil {
		t.Fatal("retired session accepted prompt")
	}
	if count != 1 {
		t.Fatal("worker recreated")
	}
}

func TestRetireRejectsRunningSession(t *testing.T) {
	m := NewManagerWithTTL(func(id, path string) (ChatWorker, error) { return &fakeChatWorker{}, nil }, 0)
	defer m.Close()
	if err := m.Send(context.Background(), "a.jsonl", "/tmp/a.jsonl", chat.Request{Message: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RetireIdle("a.jsonl"); err == nil {
		t.Fatal("running session retired")
	}
}

func TestFailedDeletionCanReleaseRetirement(t *testing.T) {
	m := NewManagerWithTTL(func(id, path string) (ChatWorker, error) { return &fakeChatWorker{}, nil }, 0)
	defer m.Close()
	rollback, err := m.RetireIdle("a.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	rollback()
	if err := m.Send(context.Background(), "a.jsonl", "/tmp/a.jsonl", chat.Request{Message: "retry"}); err != nil {
		t.Fatal(err)
	}
}

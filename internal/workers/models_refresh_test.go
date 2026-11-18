package workers

import (
	"context"
	"testing"

	"pi-web/internal/chat"
)

func TestPluginConfigAppliesToNextIdleReply(t *testing.T) {
	var created []*modelReloadWorker
	m := NewManagerWithTTL(func(string, string) (ChatWorker, error) {
		w := &modelReloadWorker{}
		created = append(created, w)
		return w, nil
	}, 0)
	defer m.Close()
	ctx := context.Background()
	if err := m.Send(ctx, "one", "one.jsonl", chat.Request{}); err != nil {
		t.Fatal(err)
	}
	m.ResourcesChanged()
	if created[0].closed || m.Status("one").State != WorkerStateRunning {
		t.Fatal("plugin configuration interrupted the running reply")
	}
	created[0].streaming = false
	if err := m.Send(ctx, "one", "one.jsonl", chat.Request{}); err != nil {
		t.Fatal(err)
	}
	if len(created) != 2 || !created[0].closed {
		t.Fatal("the next reply did not load the updated plugins")
	}
}

type modelReloadWorker struct {
	fakeChatWorker
	closed bool
}

func (w *modelReloadWorker) Close() error { w.closed = true; return nil }

func TestModelConfigReloadPreservesActiveReplyAndRefreshesIdleSelection(t *testing.T) {
	created := []*modelReloadWorker{}
	m := NewManagerWithTTL(func(string, string) (ChatWorker, error) {
		w := &modelReloadWorker{}
		created = append(created, w)
		return w, nil
	}, 0)
	defer m.Close()
	if err := m.SetModel(context.Background(), "one", "one.jsonl", "provider", "first"); err != nil {
		t.Fatal(err)
	}
	created[0].streaming = true
	m.ModelsChanged()
	if created[0].closed {
		t.Fatal("configuration change interrupted a reply")
	}
	if err := m.SetModel(context.Background(), "one", "one.jsonl", "provider", "new"); err == nil || created[0].closed {
		t.Fatal("active worker was replaced")
	}
	created[0].streaming = false
	if err := m.SetModel(context.Background(), "one", "one.jsonl", "provider", "new"); err != nil {
		t.Fatal(err)
	}
	if len(created) != 2 || !created[0].closed {
		t.Fatal("idle model selection did not load the new config")
	}
}

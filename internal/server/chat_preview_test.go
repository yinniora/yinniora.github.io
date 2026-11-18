package server

import (
	"strconv"
	"testing"

	"pi-web/internal/rpc"
)

func TestBroadcastChatPreviewKeepsLatestSnapshotAndPendingReload(t *testing.T) {
	s, err := New(Deps{AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Shutdown()
	client := s.addClient("a.jsonl")
	defer s.removeClient(client)

	other := s.addClient("b.jsonl")
	defer s.removeClient(other)

	for i := 0; i < cap(client.ch); i++ {
		client.ch <- "other-event"
	}
	s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Done: true, Revision: 1, Phase: "working"})
	for i := 2; i <= 100; i++ {
		s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{
			Content: strconv.Itoa(i), Revision: uint64(i), Phase: "reply",
		})
	}

	select {
	case latest := <-client.preview:
		if latest.snapshot.Content != "100" || latest.snapshot.Revision != 100 || latest.snapshot.Done || !latest.reload {
			t.Fatalf("unexpected preview: %+v", latest)
		}
	default:
		t.Fatalf("expected chat-preview broadcast")
	}
	select {
	case <-other.preview:
		t.Fatal("preview exposed to an unrelated session")
	default:
	}
}

func TestBroadcastChatPreviewDoesNotSendToGlobalTopic(t *testing.T) {
	s, err := New(Deps{AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Shutdown()
	client := s.addClient(globalSessID)
	defer s.removeClient(client)

	s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Content: "secret", Done: false})

	select {
	case msg := <-client.preview:
		t.Fatalf("global client received chat preview: %+v", msg)
	default:
	}
}

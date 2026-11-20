package rpc

import (
	"testing"
	"time"
)

func TestStreamPreviewAccumulatorBuildsFullContentFromTextDeltas(t *testing.T) {
	acc := &streamPreviewAccumulator{}

	first, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "hel"})
	if !ok {
		t.Fatalf("first delta did not emit preview")
	}
	if first.Content != "hel" || first.Done {
		t.Fatalf("first preview = %+v, want content hel done false", first)
	}

	second, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "lo"})
	if !ok {
		t.Fatalf("second delta did not emit preview")
	}
	if second.Content != "hello" || second.Done {
		t.Fatalf("second preview = %+v, want content hello done false", second)
	}
}

func TestStreamPreviewAccumulatorUsesTextEndContentUntilTheMessageCommits(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "draft"})

	preview, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_end", Content: "final"})
	if !ok {
		t.Fatalf("text_end did not emit preview")
	}
	if preview.Content != "final" || preview.Done {
		t.Fatalf("preview = %+v, want final block content", preview)
	}
	checkpoint, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "message_end"})
	if !ok || !checkpoint.Done || checkpoint.Phase != "working" || checkpoint.Content != "final" {
		t.Fatalf("message checkpoint = %+v, want continuing progress", checkpoint)
	}
}

func TestStreamPreviewRestoresLatestThinkingUntilCommit(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	for _, event := range []assistantMessageEvent{
		{Type: "thinking_start"},
		{Type: "thinking_delta", Delta: "Brief progress"},
		{Type: "thinking_end", Content: "Final thinking block"},
	} {
		if _, ok := acc.handleAssistantEvent(event); !ok {
			t.Fatalf("event %s did not emit progress", event.Type)
		}
	}
	if snapshot := acc.snapshot(); snapshot.Thinking != "Final thinking block" || snapshot.Phase != "thinking" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "message_end"})
	if snapshot := acc.snapshot(); snapshot.Thinking != "" || snapshot.Phase != "working" {
		t.Fatalf("committed snapshot = %+v", snapshot)
	}
}

func TestStreamPreviewAccumulatorCompletesExistingPreview(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "hello"})

	preview, ok := acc.complete()
	if !ok {
		t.Fatalf("complete did not emit preview")
	}
	if preview.Content != "hello" || !preview.Done {
		t.Fatalf("preview = %+v, want hello done", preview)
	}
	if _, ok := acc.complete(); ok {
		t.Fatalf("second complete should not emit after reset")
	}
}

func TestStreamPreviewTracksOldestRunningToolAcrossSnapshots(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "agent_start"})
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "tool_execution_start", ToolCallID: "first", ToolName: "bash"})
	acc.tools["first"] = runningTool{name: "bash", startedAt: time.Now().Add(-time.Minute)}
	second, _ := acc.handleAssistantEvent(assistantMessageEvent{Type: "tool_execution_start", ToolCallID: "second", ToolName: "read"})
	if second.ToolName != "bash" || second.ToolElapsedMs < 60000 {
		t.Fatalf("parallel tool preview = %+v, want elapsed time for bash", second)
	}
	reconnected := acc.snapshot()
	if reconnected.ToolName != "bash" || reconnected.ToolElapsedMs < second.ToolElapsedMs {
		t.Fatalf("reconnect preview = %+v, want continuing elapsed time", reconnected)
	}
	remaining, _ := acc.handleAssistantEvent(assistantMessageEvent{Type: "tool_execution_end", ToolCallID: "first"})
	if remaining.ToolName != "read" || remaining.Phase != "tool" {
		t.Fatalf("remaining tool preview = %+v, want read", remaining)
	}
	finished, _ := acc.handleAssistantEvent(assistantMessageEvent{Type: "tool_execution_end", ToolCallID: "second"})
	if finished.Phase != "working" || finished.ToolName != "" || finished.ToolElapsedMs != 0 {
		t.Fatalf("preview after tools finish = %+v", finished)
	}
}

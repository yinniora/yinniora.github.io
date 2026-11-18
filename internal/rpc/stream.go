package rpc

import (
	"strings"
	"sync/atomic"
	"unicode/utf8"

	"pi-web/internal/workers"
)

type StreamPreview = workers.LivePreview
type StreamEventSink func(StreamPreview)

type assistantMessageEvent struct {
	Type         string `json:"type"`
	Delta        string `json:"delta"`
	Content      string `json:"content"`
	ContentIndex int    `json:"contentIndex"`
	ToolCallID   string `json:"toolCallId"`
}

var previewRevision atomic.Uint64

type previewText struct {
	previous string
	current  string
	index    int
}

func (b *previewText) update(event assistantMessageEvent) {
	if b.index != event.ContentIndex || strings.HasSuffix(event.Type, "_start") {
		if b.current != "" {
			b.previous = previewTail(b.previous + b.current + "\n\n")
		}
		b.current = ""
		b.index = event.ContentIndex
	}
	switch {
	case strings.HasSuffix(event.Type, "_delta"):
		b.current = previewTail(b.current + event.Delta)
	case strings.HasSuffix(event.Type, "_end") && event.Content != "":
		b.current = previewTail(event.Content)
	}
}

func previewTail(text string) string {
	const limit = 48 * 1024
	if len(text) <= limit {
		return text
	}
	start := len(text) - limit
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	return strings.Clone(text[start:])
}

type streamPreviewAccumulator struct {
	content, thinking previewText
	phase             string
	revision          uint64
	tools             map[string]struct{}
}

func (a *streamPreviewAccumulator) snapshot() StreamPreview {
	return StreamPreview{
		Content:  previewTail(a.content.previous + a.content.current),
		Thinking: previewTail(a.thinking.previous + a.thinking.current),
		Phase:    a.phase, Revision: a.revision,
	}
}

func (a *streamPreviewAccumulator) handleAssistantEvent(event assistantMessageEvent) (StreamPreview, bool) {
	switch event.Type {
	case "agent_start":
		*a = streamPreviewAccumulator{phase: "working"}
	case "thinking_start", "thinking_delta", "thinking_end":
		a.thinking.update(event)
		a.phase = "thinking"
	case "text_start", "text_delta", "text_end":
		a.content.update(event)
		a.phase = "reply"
	case "tool_execution_start":
		if a.tools == nil {
			a.tools = make(map[string]struct{})
		}
		a.tools[event.ToolCallID] = struct{}{}
		a.phase = "tool"
	case "tool_execution_end":
		if _, active := a.tools[event.ToolCallID]; !active {
			return StreamPreview{}, false
		}
		delete(a.tools, event.ToolCallID)
		if len(a.tools) == 0 {
			a.phase = "working"
		}
	case "message_end":
		if a.phase == "" || (a.content == (previewText{}) && a.thinking == (previewText{})) {
			return StreamPreview{}, false
		}
		a.content, a.thinking = previewText{}, previewText{}
		a.phase = "working"
	case "agent_end":
		return a.complete()
	default:
		return StreamPreview{}, false
	}
	a.revision = previewRevision.Add(1)
	preview := a.snapshot()
	preview.Done = event.Type == "message_end"
	return preview, true
}

func (a *streamPreviewAccumulator) complete() (StreamPreview, bool) {
	if a.phase == "" {
		return StreamPreview{}, false
	}
	preview := a.snapshot()
	*a = streamPreviewAccumulator{}
	preview.Phase = ""
	preview.Revision = previewRevision.Add(1)
	preview.Done = true
	return preview, true
}

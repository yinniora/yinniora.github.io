package rpc

import (
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"pi-web/internal/workers"
)

type StreamPreview = workers.LivePreview
type StreamEventSink func(StreamPreview)

type assistantMessageEvent struct {
	Type             string `json:"type"`
	Delta            string `json:"delta"`
	Content          string `json:"content"`
	ContentIndex     int    `json:"contentIndex"`
	ToolCallID       string `json:"toolCallId"`
	ToolName         string `json:"toolName"`
	MessageTimestamp int64
	RetryAttempt     int
	RetryLimit       int
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
	content, thinking        previewText
	phase                    string
	revision                 uint64
	tools                    map[string]runningTool
	messageTimestamp         int64
	thinkingIndex            int
	retryAttempt, retryLimit int
}

type runningTool struct {
	name      string
	startedAt time.Time
}

func (a *streamPreviewAccumulator) snapshot() StreamPreview {
	preview := StreamPreview{
		Content:  previewTail(a.content.previous + a.content.current),
		Thinking: previewTail(a.thinking.previous + a.thinking.current),
		Phase:    a.phase, Revision: a.revision,
		MessageTimestamp: a.messageTimestamp, ThinkingIndex: a.thinkingIndex,
		RetryAttempt: a.retryAttempt, RetryLimit: a.retryLimit,
	}
	if a.phase == "tool" {
		var oldest runningTool
		for _, tool := range a.tools {
			if oldest.startedAt.IsZero() || tool.startedAt.Before(oldest.startedAt) {
				oldest = tool
			}
		}
		if !oldest.startedAt.IsZero() {
			preview.ToolName = oldest.name
			preview.ToolElapsedMs = time.Since(oldest.startedAt).Milliseconds()
		}
	}
	return preview
}

func (a *streamPreviewAccumulator) handleAssistantEvent(event assistantMessageEvent) (StreamPreview, bool) {
	if event.MessageTimestamp != 0 && a.messageTimestamp != event.MessageTimestamp {
		a.content, a.thinking = previewText{}, previewText{}
		a.messageTimestamp = event.MessageTimestamp
		a.thinkingIndex = 0
	}
	switch event.Type {
	case "agent_start":
		// A retry starts a new low-level agent run, while the user turn remains
		// active. Keep its progress until another assistant message starts.
		if a.phase != "retrying" {
			*a = streamPreviewAccumulator{phase: "working"}
		}
	case "auto_retry_start":
		a.phase = "retrying"
		a.retryAttempt, a.retryLimit = event.RetryAttempt, event.RetryLimit
	case "auto_retry_end":
		a.retryAttempt, a.retryLimit = 0, 0
		if a.phase == "retrying" {
			a.phase = "working"
		}
	case "compaction_start":
		a.phase = "compacting"
	case "compaction_end":
		if a.phase != "compacting" {
			return StreamPreview{}, false
		}
		a.phase = "working"
	case "thinking_start", "thinking_delta", "thinking_end":
		if a.thinking == (previewText{}) {
			a.thinkingIndex = event.ContentIndex
		}
		a.thinking.update(event)
		a.phase = "thinking"
	case "text_start", "text_delta", "text_end":
		a.content.update(event)
		a.phase = "reply"
	case "tool_execution_start":
		if a.tools == nil {
			a.tools = make(map[string]runningTool)
		}
		a.tools[event.ToolCallID] = runningTool{name: event.ToolName, startedAt: time.Now()}
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
		if len(a.tools) == 0 {
			a.phase = "working"
		}
	case "agent_end":
		return a.complete()
	default:
		return StreamPreview{}, false
	}
	a.revision = previewRevision.Add(1)
	preview := a.snapshot()
	preview.Done = event.Type == "message_end"
	if preview.Done {
		a.content, a.thinking = previewText{}, previewText{}
	}
	return preview, true
}

func (a *streamPreviewAccumulator) complete() (StreamPreview, bool) {
	if a.phase == "" {
		return StreamPreview{}, false
	}
	preview := a.snapshot()
	*a = streamPreviewAccumulator{}
	preview.Phase = ""
	preview.ToolName, preview.ToolElapsedMs = "", 0
	preview.Revision = previewRevision.Add(1)
	preview.Done = true
	return preview, true
}

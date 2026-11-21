package workers

import (
	"context"
	"encoding/json"
	"errors"
)

type PiSessionAction string

const (
	PiSessionStats   PiSessionAction = "get_session_stats"
	PiSessionCompact PiSessionAction = "compact"
	PiSessionExport  PiSessionAction = "export_html"
)

type PiSessionStatistics struct {
	TotalMessages int `json:"totalMessages"`
	ToolCalls     int `json:"toolCalls"`
	Tokens        struct {
		Total      int  `json:"total"`
		CacheRead  int  `json:"cacheRead"`
		Input      *int `json:"input,omitempty"`
		Output     *int `json:"output,omitempty"`
		CacheWrite *int `json:"cacheWrite,omitempty"`
	} `json:"tokens"`
	ContextUsage *struct {
		Tokens        *int `json:"tokens"`
		ContextWindow int  `json:"contextWindow"`
	} `json:"contextUsage,omitempty"`
}

var ErrPiSessionBusy = errors.New("session is busy")
var ErrPiContextCompaction = errors.New("context compaction failed")

type piSessionWorker interface {
	PiSessionAction(context.Context, PiSessionAction, string) (json.RawMessage, error)
}

func (m *Manager) PiSessionAction(ctx context.Context, id, path string, action PiSessionAction, outputPath string) (json.RawMessage, error) {
	w, err := m.workerFor(id, path)
	if err != nil {
		return nil, err
	}
	pi, ok := w.(piSessionWorker)
	if !ok {
		return nil, errors.New("Pi session actions unavailable")
	}
	return pi.PiSessionAction(ctx, action, outputPath)
}

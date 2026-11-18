package rpc

import (
	"context"
	"encoding/json"
	"errors"

	"pi-web/internal/workers"
)

func (w *piRPCWorker) PiSessionAction(ctx context.Context, action workers.PiSessionAction, outputPath string) (json.RawMessage, error) {
	cmd := map[string]any{"id": w.nextID(), "type": string(action)}
	switch action {
	case workers.PiSessionStats:
	case workers.PiSessionExport:
		cmd["outputPath"] = outputPath
	case workers.PiSessionCompact:
		w.modelMu.Lock()
		w.mu.Lock()
		if w.status.State == workers.WorkerStateRunning || w.compacting {
			w.mu.Unlock()
			w.modelMu.Unlock()
			return nil, workers.ErrPiSessionBusy
		}
		w.compacting = true
		w.mu.Unlock()
		w.modelMu.Unlock()
		defer func() {
			w.mu.Lock()
			w.compacting = false
			w.mu.Unlock()
		}()
	default:
		return nil, errors.New("unknown Pi session action")
	}
	w.touch()
	return w.request(ctx, cmd)
}

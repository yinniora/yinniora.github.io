package rpc

import (
	"context"
	"path/filepath"
	"time"

	"pi-web/internal/sessions"
)

const compactionTimeout = 4 * time.Minute

func (w *piRPCWorker) compactContext(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, compactionTimeout)
	defer cancel()
	return w.sendAndAwait(ctx, map[string]any{"id": w.nextID(), "type": "compact"})
}

func needsCompaction(path string, model model) bool {
	session, err := sessions.ParseFile(path, filepath.Base(filepath.Dir(path)), filepath.Base(path))
	if err != nil {
		return false
	}
	byID := make(map[string]map[string]any, len(session.Entries))
	var leaf string
	for _, entry := range session.Entries {
		if id, _ := entry["id"].(string); id != "" {
			byID[id] = entry
			leaf = id
		}
	}
	reserve := min(model.MaxTokens+4096, model.ContextWindow/3)
	for i := 0; leaf != "" && i < len(byID); i++ {
		entry := byID[leaf]
		leaf, _ = entry["parentId"].(string)
		if entry["type"] == "compaction" {
			return false
		}
		message, _ := entry["message"].(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		usage, _ := message["usage"].(map[string]any)
		tokens, _ := usage["totalTokens"].(float64)
		if tokens <= 0 {
			continue
		}
		// Pi can drop a failed assistant attempt from the active model context.
		// Its recorded measurement still includes the prompt that exhausted it.
		return message["model"] == model.ID && message["provider"] == model.Provider &&
			tokens > float64(model.ContextWindow-reserve)
	}
	return false
}

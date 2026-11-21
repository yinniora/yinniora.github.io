package rpc

import (
	"context"
	"path/filepath"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
)

const (
	compactionTimeout    = 4 * time.Minute
	recentCacheHitWindow = 4 * time.Minute
	estimatedImageTokens = 1200
)

func (w *piRPCWorker) compactContext(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, compactionTimeout)
	defer cancel()
	return w.sendAndAwait(ctx, map[string]any{"id": w.nextID(), "type": "compact"})
}

// compactionThreshold is the prompt size that triggers a compaction.
//
// A recent cache hit can defer early compaction, but output headroom always applies.
func compactionThreshold(model model, cacheHit bool) int {
	reserve := min(model.MaxTokens+4096, model.ContextWindow/3)
	threshold := model.ContextWindow - reserve
	if !cacheHit {
		threshold = min(threshold, model.ContextWindow*8/10)
	}
	return threshold
}

func needsCompaction(path string, model model, request chat.Request) bool {
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
	// Mirror Pi's 1200-token estimate per image. Bytes instead of characters
	// preserve extra headroom for non-ASCII prompts and source snippets.
	promptTokens := (len(request.Message)+3)/4 + estimatedImageTokens*len(request.Images)
	if promptTokens >= compactionThreshold(model, true) {
		return false
	}
	trailingTokens := promptTokens
	var edited bool
	for i := 0; leaf != "" && i < len(byID); i++ {
		entry := byID[leaf]
		leaf, _ = entry["parentId"].(string)
		if entry["type"] == "compaction" {
			return false
		}
		if entry["type"] == "context_edit" && !archivesEmptyFailedReply(entry, byID) {
			edited = true
		}
		message, _ := entry["message"].(map[string]any)
		if message["role"] != "assistant" {
			trailingTokens += estimatedContentTokens(message["content"])
			continue
		}
		usage, _ := message["usage"].(map[string]any)
		tokens, _ := usage["totalTokens"].(float64)
		input, _ := usage["input"].(float64)
		read, _ := usage["cacheRead"].(float64)
		write, _ := usage["cacheWrite"].(float64)
		if tokens <= 0 {
			output, _ := usage["output"].(float64)
			tokens = input + read + write + output
		}
		if tokens <= 0 {
			continue
		}
		sameModel := message["model"] == model.ID && message["provider"] == model.Provider
		lengthStop := message["stopReason"] == "length"
		if edited && !(sameModel && lengthStop) {
			// Pi owns projection of explicit context edits. Retain the measurement
			// for a length stop archived by the runtime during overflow recovery.
			return false
		}
		cacheHit := sameModel && !edited && !lengthStop && read >= (input+read+write)*0.8 && read > 0
		if cacheHit {
			timestamp, _ := entry["timestamp"].(string)
			completedAt, err := time.Parse(time.RFC3339, timestamp)
			age := time.Since(completedAt)
			cacheHit = err == nil && age >= 0 && age < recentCacheHitWindow
		}
		threshold := compactionThreshold(model, cacheHit || !sameModel)
		return tokens+float64(trailingTokens) >= float64(threshold)
	}
	return false
}

func archivesEmptyFailedReply(edit map[string]any, byID map[string]map[string]any) bool {
	if replacement, exists := edit["replacement"]; !exists || replacement != nil {
		return false
	}
	targetID, _ := edit["targetId"].(string)
	message, _ := byID[targetID]["message"].(map[string]any)
	if message["role"] != "assistant" || message["stopReason"] != "error" {
		return false
	}
	content, ok := message["content"].([]any)
	if !ok || len(content) != 0 {
		return false
	}
	usage, _ := message["usage"].(map[string]any)
	if usage["totalTokens"] != float64(0) {
		return false
	}
	for _, key := range []string{"input", "cacheRead", "cacheWrite", "output"} {
		if tokens, _ := usage[key].(float64); tokens != 0 {
			return false
		}
	}
	return true
}

func estimatedContentTokens(content any) int {
	switch content := content.(type) {
	case string:
		return (len(content) + 3) / 4
	case []any:
		tokens := 0
		for _, entry := range content {
			block, _ := entry.(map[string]any)
			switch block["type"] {
			case "text":
				text, _ := block["text"].(string)
				tokens += (len(text) + 3) / 4
			case "image":
				tokens += estimatedImageTokens
			}
		}
		return tokens
	default:
		return 0
	}
}

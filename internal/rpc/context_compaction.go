package rpc

import (
	"context"
	"encoding/json"
	"path/filepath"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

const (
	compactionTimeout    = 4 * time.Minute
	contextStatsTimeout  = 800 * time.Millisecond
	recentCacheHitWindow = 4 * time.Minute
	estimatedImageTokens = 1200
	compactInstructions  = "Aim for a summary of about 600 words or less. Preserve the current goal, user decisions, constraints, unfinished tasks, and evidence and file references needed to resume. Condense completed work and logs to their outcomes. Use extra space for details needed to avoid repeating work or losing correctness."
)

func compactCommand(id string) map[string]any {
	return map[string]any{"id": id, "type": "compact", "customInstructions": compactInstructions}
}

func (w *piRPCWorker) compactContext(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, compactionTimeout)
	defer cancel()
	return w.sendAndAwait(ctx, compactCommand(w.nextID()))
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

func (w *piRPCWorker) shouldCompactContext(ctx context.Context, limits model, request chat.Request) bool {
	statsCtx, cancel := context.WithTimeout(ctx, contextStatsTimeout)
	data, err := w.PiSessionAction(statsCtx, workers.PiSessionStats, "")
	cancel()
	if ctx.Err() != nil {
		return false
	}
	var stats workers.PiSessionStatistics
	if err != nil || json.Unmarshal(data, &stats) != nil || stats.ContextUsage == nil || stats.ContextUsage.Tokens == nil || *stats.ContextUsage.Tokens <= 0 {
		// Older workers omit this estimate. The branch history also keeps usage
		// from an output-length failure that the runtime has since archived.
		return needsCompaction(w.sessionPath, limits, request)
	}
	if stats.ContextUsage.ContextWindow > 0 {
		limits.ContextWindow = stats.ContextUsage.ContextWindow
	}
	promptTokens := estimatedPromptTokens(request)
	return shouldCompactMeasuredContext(*stats.ContextUsage.Tokens, promptTokens, limits, func() bool {
		_, deferEarly := measureRecentContext(w.sessionPath, limits)
		return deferEarly
	})
}

func shouldCompactMeasuredContext(tokens, promptTokens int, limits model, deferEarly func() bool) bool {
	hardLimit := compactionThreshold(limits, true)
	if promptTokens >= hardLimit || tokens == 0 {
		return false
	}
	if tokens >= hardLimit-promptTokens {
		return true
	}
	return tokens >= compactionThreshold(limits, false)-promptTokens && !deferEarly()
}

func needsCompaction(path string, model model, request chat.Request) bool {
	tokens, deferEarly := measureRecentContext(path, model)
	return shouldCompactMeasuredContext(tokens, estimatedPromptTokens(request), model, func() bool { return deferEarly })
}

func estimatedPromptTokens(request chat.Request) int {
	// Pi estimates 1200 tokens per image. Using bytes for text leaves headroom
	// for non-ASCII prompts and code until there is a provider measurement.
	return (len(request.Message)+3)/4 + estimatedImageTokens*len(request.Images)
}

func measureRecentContext(path string, model model) (tokens int, deferEarly bool) {
	session, err := sessions.ParseFile(path, filepath.Base(filepath.Dir(path)), filepath.Base(path))
	if err != nil {
		return 0, false
	}
	byID := make(map[string]map[string]any, len(session.Entries))
	var leaf string
	for _, entry := range session.Entries {
		if id, _ := entry["id"].(string); id != "" {
			byID[id] = entry
			leaf = id
		}
	}
	trailingTokens := 0
	var edited bool
	for i := 0; leaf != "" && i < len(byID); i++ {
		entry := byID[leaf]
		leaf, _ = entry["parentId"].(string)
		if entry["type"] == "compaction" {
			return 0, false
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
			return 0, false
		}
		cacheHit := sameModel && !edited && !lengthStop && read >= (input+read+write)*0.8 && read > 0
		if cacheHit {
			timestamp, _ := entry["timestamp"].(string)
			completedAt, err := time.Parse(time.RFC3339, timestamp)
			age := time.Since(completedAt)
			cacheHit = err == nil && age >= 0 && age < recentCacheHitWindow
		}
		return int(tokens) + trailingTokens, cacheHit || !sameModel
	}
	return 0, false
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

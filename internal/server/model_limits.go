package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

//go:embed model_limits.json
var bundledModelLimitsJSON []byte

var bundledModelLimits = func() map[string][2]int {
	var models map[string][2]int
	if err := json.Unmarshal(bundledModelLimitsJSON, &models); err != nil {
		panic(err)
	}
	return models
}()

var modelLimitFields = [...]string{"contextWindow", "maxTokens"}

const maximumTokenLimit = 10000000

func modelLimitsForID(id string) [2]int {
	if limits, ok := bundledModelLimits[id]; ok {
		return limits
	}
	return bundledModelLimits[fixedThinkingAlias.ReplaceAllString(id, "")]
}

type nativeModelLimitCache struct {
	mu      sync.Mutex
	entries map[string]*nativeModelLimitEntry
	client  *http.Client
}

type nativeModelLimitEntry struct {
	models map[string][2]int
	ready  chan struct{}
	until  time.Time
}

func (c *nativeModelLimitCache) lookup(ctx context.Context, id string) [2]int {
	baseID := fixedThinkingAlias.ReplaceAllString(id, "")
	provider := nativeCatalogProvider(baseID)
	if provider == "" {
		return [2]int{}
	}
	c.mu.Lock()
	entry := c.entries[provider]
	if entry != nil && (entry.until.IsZero() || time.Now().Before(entry.until)) {
		c.mu.Unlock()
		select {
		case <-entry.ready:
			if limits := entry.models[id]; limits != ([2]int{}) {
				return limits
			}
			return entry.models[baseID]
		case <-ctx.Done():
			return [2]int{}
		}
	}
	if c.entries == nil {
		c.entries = make(map[string]*nativeModelLimitEntry)
	}
	entry = &nativeModelLimitEntry{ready: make(chan struct{})}
	c.entries[provider] = entry
	c.mu.Unlock()

	models := c.fetch(ctx, provider)
	c.mu.Lock()
	entry.models = models
	entry.until = time.Now().Add(6 * time.Hour)
	if len(models) == 0 {
		entry.until = time.Now().Add(2 * time.Minute)
	}
	close(entry.ready)
	c.mu.Unlock()
	if limits := models[id]; limits != ([2]int{}) {
		return limits
	}
	return models[baseID]
}

func nativeCatalogProvider(id string) string {
	switch {
	case strings.HasPrefix(id, "claude-"):
		return "anthropic"
	case strings.HasPrefix(id, "gemini-"):
		return "google"
	case strings.HasPrefix(id, "gpt-") || strings.HasPrefix(id, "o1") || strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4"):
		return "openai"
	case strings.HasPrefix(id, "deepseek-"):
		return "deepseek"
	case strings.HasPrefix(id, "grok-"):
		return "xai"
	case strings.HasPrefix(id, "kimi-"):
		return "moonshotai"
	case strings.HasPrefix(id, "mistral-") || strings.HasPrefix(id, "devstral-") ||
		strings.HasPrefix(id, "codestral-"):
		return "mistral"
	case strings.HasPrefix(id, "MiniMax-") || strings.HasPrefix(id, "minimax-"):
		return "minimax"
	case strings.HasPrefix(id, "glm-"):
		return "zai"
	case strings.HasPrefix(id, "qwen"):
		return "qwen-token-plan"
	}
	return ""
}

func (c *nativeModelLimitCache) fetch(ctx context.Context, provider string) map[string][2]int {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// The provider route is from nativeCatalogProvider. Send only a public
	// family name and omit all API-key and local model-ID data.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://pi.dev/api/models/providers/"+provider+"?types=chat", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	client := c.client
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var data []struct {
		ID            string `json:"id"`
		ContextWindow int    `json:"contextWindow"`
		MaxTokens     int    `json:"maxTokens"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&data); err != nil {
		return nil
	}
	models := make(map[string][2]int, len(data))
	for _, m := range data {
		if m.ID != "" && m.ContextWindow > 0 && m.ContextWindow <= maximumTokenLimit &&
			m.MaxTokens > 0 && m.MaxTokens <= maximumTokenLimit {
			models[m.ID] = [2]int{m.ContextWindow, m.MaxTokens}
		}
	}
	return models
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type modelBalance struct {
	Status string   `json:"status"`
	Scope  string   `json:"scope,omitempty"`
	Amount *float64 `json:"amount,omitempty"`
	Unit   string   `json:"unit,omitempty"`
}

type modelBalanceSource struct {
	id        string
	base      *url.URL
	key       string
	signature string
}

type modelBalanceCache struct {
	mu      sync.Mutex
	entries map[string]*modelBalanceEntry
}

type modelBalanceEntry struct {
	signature string
	ready     chan struct{}
	until     time.Time
	result    modelBalance
}

var balanceHTTPClient = &http.Client{
	Timeout: 4 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func (s *Server) handleModelBalances(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	s.modelConfigMu.Lock()
	_, providers, _, err := readModelConfig(s.agentDir)
	if err != nil {
		s.modelConfigMu.Unlock()
		writeJSONError(w, 400, "cannot read model profiles")
		return
	}
	sources := make([]modelBalanceSource, 0, len(providers))
	for id, raw := range providers {
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		base, _ := p["baseUrl"].(string)
		api, _ := p["api"].(string)
		key := s.modelProfileKey(id, p)
		u, e := modelBaseURL(base, api)
		if e == nil && key != "" {
			sources = append(sources, modelBalanceSource{id, u, key, profileSignature(p, key)})
		}
	}
	s.modelConfigMu.Unlock()
	results := make([]modelBalance, len(sources))
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	var pending sync.WaitGroup
	workers := min(4, len(sources))
	for worker := range workers {
		pending.Go(func() {
			for i := worker; i < len(sources) && ctx.Err() == nil; i += workers {
				results[i] = s.modelBalances.get(ctx, sources[i])
			}
		})
	}
	pending.Wait()
	balances := make(map[string]modelBalance, len(sources))
	for i, source := range sources {
		if results[i].Status != "" {
			balances[source.id] = results[i]
		}
	}
	writeJSON(w, 200, map[string]any{"balances": balances})
}

func (c *modelBalanceCache) get(ctx context.Context, source modelBalanceSource) modelBalance {
	c.mu.Lock()
	entry := c.entries[source.id]
	if entry != nil && entry.signature == source.signature {
		if entry.until.IsZero() {
			c.mu.Unlock()
			select {
			case <-entry.ready:
				return entry.result
			case <-ctx.Done():
				return modelBalance{Status: "unavailable"}
			}
		}
		if time.Now().Before(entry.until) {
			result := entry.result
			c.mu.Unlock()
			return result
		}
	}
	if c.entries == nil {
		c.entries = make(map[string]*modelBalanceEntry)
	}
	for id, existing := range c.entries {
		if !existing.until.IsZero() && time.Now().After(existing.until) {
			delete(c.entries, id)
		}
	}
	entry = &modelBalanceEntry{signature: source.signature, ready: make(chan struct{})}
	c.entries[source.id] = entry
	c.mu.Unlock()

	result := fetchModelBalance(ctx, source)
	c.mu.Lock()
	entry.result = result
	entry.until = time.Now().Add(time.Minute)
	if result.Status == "unsupported" {
		entry.until = time.Now().Add(5 * time.Minute)
	}
	if ctx.Err() != nil && c.entries[source.id] == entry {
		delete(c.entries, source.id)
	}
	close(entry.ready)
	c.mu.Unlock()
	return result
}

func fetchModelBalance(ctx context.Context, source modelBalanceSource) modelBalance {
	u := *source.base
	// OpenAI inference keys do not implement the New API balance endpoint.
	if isOfficialOpenAI(&u) {
		return modelBalance{Status: "unsupported"}
	}
	if strings.EqualFold(u.Hostname(), "openrouter.ai") && u.Port() == "" && u.Scheme == "https" {
		u.Path = "/api/v1/key"
		var doc struct {
			Data struct {
				Remaining *float64        `json:"limit_remaining"`
				Limit     json.RawMessage `json:"limit"`
			} `json:"data"`
		}
		if getBalanceJSON(ctx, u, source.key, &doc) != 200 {
			return modelBalance{Status: "unavailable"}
		}
		if doc.Data.Remaining != nil {
			return modelBalance{Status: "available", Scope: "key", Amount: doc.Data.Remaining, Unit: "USD"}
		}
		if string(doc.Data.Limit) == "null" {
			return modelBalance{Status: "unlimited"}
		}
		return modelBalance{Status: "unavailable"}
	}
	return fetchNewAPIBalance(ctx, u, source.key)
}

func fetchNewAPIBalance(ctx context.Context, u url.URL, key string) modelBalance {
	prefix := strings.TrimSuffix(strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1beta"), "/v1")
	u.Path, u.RawPath = prefix+"/api/usage/token/", ""
	var doc struct {
		Code bool `json:"code"`
		Data struct {
			Object    string   `json:"object"`
			Remaining *float64 `json:"total_available"`
			Unlimited bool     `json:"unlimited_quota"`
			Account   *struct {
				Remaining *float64 `json:"total_available"`
			} `json:"user_quota"`
		} `json:"data"`
	}
	status := getBalanceJSON(ctx, u, key, &doc)
	if status == 404 || (status >= 300 && status < 400) {
		u.Path = strings.TrimSuffix(u.Path, "/")
		status = getBalanceJSON(ctx, u, key, &doc)
	}
	if status == 404 || status == 405 || (status == 200 && doc.Data.Object != "token_usage") {
		return modelBalance{Status: "unsupported"}
	}
	if status != 200 || !doc.Code {
		return modelBalance{Status: "unavailable"}
	}
	remaining, scope := doc.Data.Remaining, "key"
	if doc.Data.Unlimited {
		remaining = nil
	}
	if wallet := doc.Data.Account; wallet != nil && wallet.Remaining != nil && (remaining == nil || *wallet.Remaining < *remaining) {
		remaining, scope = wallet.Remaining, "account"
	}
	if remaining == nil {
		if doc.Data.Unlimited {
			return modelBalance{Status: "unlimited"}
		}
		return modelBalance{Status: "unavailable"}
	}
	var site struct {
		Data struct {
			QuotaPerUnit float64 `json:"quota_per_unit"`
			Display      string  `json:"quota_display_type"`
			ExchangeRate float64 `json:"usd_exchange_rate"`
		} `json:"data"`
	}
	u.Path = prefix + "/api/status"
	if getBalanceJSON(ctx, u, "", &site) == 200 && site.Data.QuotaPerUnit > 0 {
		amount := *remaining / site.Data.QuotaPerUnit
		unit := site.Data.Display
		if unit == "CNY" && site.Data.ExchangeRate > 0 {
			amount *= site.Data.ExchangeRate
		} else if unit != "USD" {
			unit = ""
		}
		if unit != "" && !math.IsInf(amount, 0) {
			return modelBalance{Status: "available", Scope: scope, Amount: &amount, Unit: unit}
		}
	}
	return modelBalance{Status: "available", Scope: scope, Amount: remaining, Unit: "quota"}
}

func getBalanceJSON(ctx context.Context, u url.URL, key string, target any) int {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0
	}
	req.Header.Set("Accept", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := balanceHTTPClient.Do(req)
	if err != nil {
		return 0
	}
	defer response.Body.Close()
	if response.StatusCode == 200 {
		const maxSize = 512 << 10
		body, err := io.ReadAll(io.LimitReader(response.Body, maxSize+1))
		if err != nil || len(body) > maxSize || json.Unmarshal(body, target) != nil {
			return 0
		}
	}
	return response.StatusCode
}

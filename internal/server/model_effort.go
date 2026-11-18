package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var errEffortUnconfirmed = errors.New("model effort is unconfirmed")

func effortEndpoint(profile, model map[string]any) (*url.URL, string) {
	api, _ := model["api"].(string)
	if api == "" {
		api, _ = profile["api"].(string)
	}
	base, _ := model["baseUrl"].(string)
	if base == "" {
		base, _ = profile["baseUrl"].(string)
	}
	u, err := modelBaseURL(base, api)
	if err != nil {
		return nil, ""
	}
	switch api {
	case apiChat:
		u.Path = strings.TrimRight(u.Path, "/") + "/chat/completions"
	case apiResponses:
		u.Path = strings.TrimRight(u.Path, "/") + "/responses"
	case apiAnthropic:
		u.Path = strings.TrimRight(u.Path, "/") + "/messages"
	default:
		return nil, ""
	}
	return u, api
}

func modelEffortCheckable(profile, model map[string]any) bool {
	id, _ := model["id"].(string)
	u, _ := effortEndpoint(profile, model)
	compat, _ := model["compat"].(map[string]any)
	format, _ := compat["thinkingFormat"].(string)
	return id != "" && model["reasoning"] != true && !fixedThinkingAlias.MatchString(id) &&
		u != nil && (format == "" || format == "openai" || format == "openrouter")
}

// Only a model whose endpoint rejects an invalid effort and accepts a valid
// level can be enabled from this explicit check. Some gateways silently
// discard unfamiliar fields and return 200 for every input.
func verifyModelEffort(ctx context.Context, profile, model map[string]any, key string) (map[string]any, map[string]any, error) {
	u, api := effortEndpoint(profile, model)
	if u == nil || key == "" || !modelEffortCheckable(profile, model) {
		return nil, nil, errEffortUnconfirmed
	}
	id, _ := model["id"].(string)
	const prompt = "Reply with the number 1."
	compat := map[string]any{}
	profileCompat, _ := profile["compat"].(map[string]any)
	for k, v := range profileCompat {
		compat[k] = v
	}
	if existing, ok := model["compat"].(map[string]any); ok {
		for k, v := range existing {
			compat[k] = v
		}
	}
	format, _ := compat["thinkingFormat"].(string)
	if api == apiChat && format != "" && format != "openai" && format != "openrouter" {
		return nil, nil, errEffortUnconfirmed
	}
	nested := api == apiResponses || (api == apiChat && (format == "openrouter" || (format == "" && u.Hostname() == "openrouter.ai")))
	client := &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	probe := func(level string, invalid bool) bool {
		data := map[string]any{"model": id, "max_tokens": 128,
			"messages": []map[string]string{{"role": "user", "content": prompt}}}
		switch api {
		case apiResponses:
			delete(data, "messages")
			delete(data, "max_tokens")
			data["input"], data["max_output_tokens"] = prompt, 128
			data["reasoning"] = map[string]string{"effort": level}
		case apiAnthropic:
			data["thinking"] = map[string]string{"type": "adaptive"}
			data["output_config"] = map[string]string{"effort": level}
		case apiChat:
			if compat["maxTokensField"] == "max_completion_tokens" || u.Hostname() == "api.openai.com" {
				delete(data, "max_tokens")
				data["max_completion_tokens"] = 128
			}
			if nested {
				data["reasoning"] = map[string]string{"effort": level}
			} else {
				data["reasoning_effort"] = level
			}
		}
		payload, _ := json.Marshal(data)
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
		if err != nil {
			return false
		}
		request.Header.Set("Content-Type", "application/json")
		if api == apiAnthropic {
			request.Header.Set("anthropic-version", "2023-06-01")
			request.Header.Set("x-api-key", key)
		}
		if api != apiAnthropic || profile["authHeader"] == true {
			request.Header.Set("Authorization", "Bearer "+key)
		}
		response, err := client.Do(request)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if err != nil {
			return false
		}
		if invalid {
			return (response.StatusCode == 400 || response.StatusCode == 422) &&
				strings.Contains(strings.ToLower(string(body)), "effort")
		}
		var document map[string]any
		if response.StatusCode != 200 || json.Unmarshal(body, &document) != nil || document["error"] != nil {
			return false
		}
		return document["choices"] != nil || document["output"] != nil || document["content"] != nil
	}
	if !probe("yugo-invalid-effort", true) {
		return nil, nil, errEffortUnconfirmed
	}
	levels := map[string]bool{}
	for _, level := range []string{"low", "high"} {
		levels[level] = probe(level, false)
	}
	if ctx.Err() != nil || (!levels["low"] && !levels["high"]) {
		return nil, nil, errEffortUnconfirmed
	}
	allowed := declaredEffortLevels(levels)
	if api == apiChat {
		// Leave the parameter out at the default setting. The probe did not
		// establish that "none" is a supported provider value.
		delete(allowed, "off")
		if nested {
			compat["thinkingFormat"] = "openrouter"
			// OpenRouter sends "none" when off has no explicit mapping.
			allowed["off"] = nil
		} else {
			compat["supportsReasoningEffort"] = true
		}
	}
	if api == apiAnthropic {
		compat["forceAdaptiveThinking"] = true
	}
	count := 0
	for _, providerLevel := range allowed {
		if providerLevel != nil {
			count++
		}
	}
	if _, mapped := allowed["off"]; !mapped {
		count++
	}
	if count < 2 {
		return nil, nil, errEffortUnconfirmed
	}
	return allowed, compat, nil
}

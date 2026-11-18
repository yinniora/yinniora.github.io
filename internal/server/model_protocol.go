package server

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const (
	apiChat      = "openai-completions"
	apiResponses = "openai-responses"
	apiAnthropic = "anthropic-messages"
	apiGemini    = "google-generative-ai"
)

func (s *Server) detectModelProtocol(ctx context.Context, base, key string) (*url.URL, string, []map[string]any, error) {
	apis := []string{apiChat, apiAnthropic, apiGemini}
	if u, err := url.Parse(strings.TrimRight(base, "/")); err == nil {
		for _, route := range []struct{ suffix, api string }{{"/chat/completions", apiChat}, {"/responses", apiResponses}, {"/messages", apiAnthropic}} {
			if strings.HasSuffix(u.Path, route.suffix) {
				u.Path = strings.TrimSuffix(u.Path, route.suffix)
				base, apis = u.String(), []string{route.api}
				break
			}
		}
		if strings.HasSuffix(u.Path, "/v1beta") {
			apis = []string{apiGemini, apiChat}
		}
	}
	var lastErr error
	for _, api := range apis {
		u, err := modelBaseURL(base, api)
		if err != nil {
			return nil, "", nil, err
		}
		models, err := s.discoverModels(ctx, map[string]any{"baseUrl": u.String(), "api": api}, key)
		if err == nil {
			return u, api, models, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, "", nil, fmt.Errorf("could not detect model API: %w", lastErr)
}

var fixedThinkingAlias = regexp.MustCompile(`(?i)(?:-(?:thinking|nothinking|high|medium|low|xhigh|max)(?:-(?:high|medium|low|xhigh|max|[0-9]+))?|@(?:thinking|effort):[^@]+)$`)
var adaptiveClaude = regexp.MustCompile(`^claude-(?:opus-(?:4-[678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5)(?:-[0-9]{8})?$`)

func catalogStrings(value any) map[string]bool {
	items, _ := value.([]any)
	out := make(map[string]bool, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out[strings.ToLower(s)] = true
		}
	}
	return out
}

func describeCatalogModel(model, raw map[string]any, id, api, base string) {
	types := catalogStrings(raw["supported_endpoint_types"])
	params := catalogStrings(raw["supported_parameters"])
	// New API can expose Claude, Gemini and GPT through the same key.
	if len(types) > 0 && api != apiResponses {
		switch {
		case types["anthropic"] && strings.Contains(strings.ToLower(id), "claude"):
			api = apiAnthropic
		case types["gemini"] && strings.Contains(strings.ToLower(id), "gemini"):
			api = apiGemini
		case types["openai-response"] || types["openai-responses"] || types["openai responses"]:
			api = apiResponses
		case types["openai"]:
			api = apiChat
		}
	}
	model["api"] = api
	if api == apiGemini {
		if u, err := url.Parse(base); err == nil && strings.HasSuffix(u.Path, "/v1") {
			u.Path = strings.TrimSuffix(u.Path, "/v1") + "/v1beta"
			model["baseUrl"] = u.String()
		}
	}
	architecture, _ := raw["architecture"].(map[string]any)
	modalities := catalogStrings(architecture["input_modalities"])
	if modalities["image"] || (api == apiAnthropic && adaptiveClaude.MatchString(id)) {
		model["input"] = []string{"text", "image"}
	}
	if params["tools"] || params["tool_choice"] {
		model["supportsTools"] = true
	}
	if fixedThinkingAlias.MatchString(id) {
		return
	}
	providerURL, _ := url.Parse(base)
	host := ""
	if providerURL != nil {
		host = providerURL.Hostname()
	}
	if api == apiAnthropic && adaptiveClaude.MatchString(id) && (host == "api.anthropic.com" || params["output_config"] || params["effort"]) {
		model["reasoning"] = true
		model["compat"] = map[string]any{"forceAdaptiveThinking": true}
		levels := map[string]any{"minimal": nil}
		if strings.Contains(id, "-5") {
			levels["off"] = nil
			levels["xhigh"] = "xhigh"
		}
		model["thinkingLevelMap"] = levels
	} else if api == apiResponses && (params["reasoning"] || params["reasoning_effort"]) {
		model["reasoning"] = true
	} else if api == apiChat {
		switch {
		case params["reasoning"] && host == "openrouter.ai":
			model["reasoning"] = true
			model["compat"] = map[string]any{"thinkingFormat": "openrouter"}
		case params["reasoning_effort"]:
			model["reasoning"] = true
			model["compat"] = map[string]any{"supportsReasoningEffort": true}
		}
	}
	if model["reasoning"] == true {
		if levels := catalogStrings(raw["supported_reasoning_efforts"]); len(levels) > 0 {
			thinkingLevels := map[string]any{"off": nil, "minimal": nil, "low": nil, "medium": nil, "high": nil, "xhigh": nil}
			for level := range thinkingLevels {
				if levels[level] {
					thinkingLevels[level] = level
				}
			}
			if levels["none"] {
				thinkingLevels["off"] = "none"
			}
			model["thinkingLevelMap"] = thinkingLevels
		}
	}
}

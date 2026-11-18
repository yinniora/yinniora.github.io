package server

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const (
	apiChat      = "openai-completions"
	apiResponses = "openai-responses"
	apiAnthropic = "anthropic-messages"
	apiGemini    = "google-generative-ai"
)

func modelProtocolRoute(base string) (string, string) {
	base = strings.TrimRight(base, "/")
	u, err := url.Parse(base)
	if err != nil {
		return base, ""
	}
	for _, route := range []struct{ suffix, api string }{{"/chat/completions", apiChat}, {"/responses", apiResponses}, {"/messages", apiAnthropic}} {
		if strings.HasSuffix(u.Path, route.suffix) {
			u.Path = strings.TrimSuffix(u.Path, route.suffix)
			u.RawPath = ""
			return u.String(), route.api
		}
	}
	return base, ""
}

func (s *Server) detectModelProtocol(ctx context.Context, base, key, preferred string) (*url.URL, string, []map[string]any, error) {
	base, explicit := modelProtocolRoute(base)
	apis := []string{apiChat, apiAnthropic, apiGemini}
	if explicit != "" {
		apis = []string{explicit}
	} else if preferred == apiAnthropic {
		// Proxies can advertise alternate model routes in their Bearer catalog.
		apis = []string{apiChat, apiAnthropic, apiGemini}
	} else if preferred != "" {
		apis = append([]string{preferred}, slices.DeleteFunc(apis, func(api string) bool { return api == preferred })...)
	} else if strings.HasSuffix(base, "/v1beta") {
		apis = []string{apiGemini, apiChat, apiAnthropic}
	}
	var lastErr error
	for _, api := range apis {
		u, err := modelBaseURL(base, api)
		if err != nil {
			return nil, "", nil, err
		}
		profile := map[string]any{"baseUrl": u.String(), "api": api}
		if explicit == "" && api == apiChat && (preferred == apiAnthropic || preferred == apiResponses) {
			profile["catalogFallbackAPI"] = preferred
		}
		models, err := s.discoverModels(ctx, profile, key)
		if err == nil {
			if fallback, ok := profile["catalogFallbackAPI"].(string); ok {
				api = fallback
			}
			if explicit == "" && len(models) > 0 {
				catalogAPI, _ := models[0]["api"].(string)
				if catalogAPI != "" && !slices.ContainsFunc(models, func(model map[string]any) bool { return model["api"] != catalogAPI }) {
					api = catalogAPI
					if modelBase, ok := models[0]["baseUrl"].(string); ok {
						if modelURL, err := modelBaseURL(modelBase, api); err == nil {
							u = modelURL
						}
					}
				}
			}
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
var adaptiveClaude = regexp.MustCompile(`^claude-(?:opus-(?:4-[678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5|(?:fable|mythos)-5(?:-[12])?)(?:-[0-9]{8})?$`)

func catalogStrings(value any) map[string]bool {
	items, _ := value.([]any)
	out := make(map[string]bool, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out[strings.ToLower(strings.TrimSpace(s))] = true
		}
	}
	return out
}

func declaredEffortLevels(levels map[string]bool) map[string]any {
	result := map[string]any{"off": nil, "minimal": nil, "low": nil, "medium": nil, "high": nil, "xhigh": nil, "max": nil}
	for level := range result {
		if level != "off" && levels[level] {
			result[level] = level
		}
	}
	if levels["none"] {
		result["off"] = "none"
	} else if levels["off"] {
		result["off"] = "off"
	}
	return result
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
	levels := catalogStrings(raw["supported_reasoning_efforts"])
	capabilities, _ := raw["capabilities"].(map[string]any)
	reasoning, _ := capabilities["reasoning"].(map[string]any)
	if reasoning["supported"] == false {
		return
	}
	if len(levels) == 0 {
		levels = catalogStrings(reasoning["effort"])
		delete(levels, "default")
		if len(levels) > 0 && reasoning["toggle"] == true && (api == apiChat || api == apiResponses) {
			levels["none"] = true
		}
	}
	if api == apiAnthropic && ((host == "api.anthropic.com" && adaptiveClaude.MatchString(id)) ||
		params["output_config.effort"] || (adaptiveClaude.MatchString(id) && (params["output_config"] || params["effort"] || len(levels) > 0))) {
		model["reasoning"] = true
		model["compat"] = map[string]any{"forceAdaptiveThinking": true}
		levels := map[string]any{"minimal": nil}
		if strings.Contains(id, "-5") {
			levels["off"] = nil
			levels["xhigh"] = "xhigh"
		}
		if id == "claude-opus-5-5" || strings.HasPrefix(id, "claude-fable-5") || strings.HasPrefix(id, "claude-mythos-5") {
			levels["max"] = "max"
		}
		model["thinkingLevelMap"] = levels
	} else if api == apiResponses && (params["reasoning"] || params["reasoning.effort"] || params["reasoning_effort"] || len(levels) > 0) {
		model["reasoning"] = true
	} else if api == apiChat {
		switch {
		case params["reasoning.effort"] || (params["reasoning"] && host == "openrouter.ai"):
			model["reasoning"] = true
			model["compat"] = map[string]any{"thinkingFormat": "openrouter"}
		case params["reasoning_effort"] || len(levels) > 0:
			model["reasoning"] = true
			model["compat"] = map[string]any{"supportsReasoningEffort": true}
		}
	} else if api == apiGemini && (raw["thinking"] == true || params["thinkingconfig.thinkinglevel"] || len(levels) > 0) {
		model["reasoning"] = true
		if len(levels) == 0 {
			levels = map[string]bool{"low": true, "medium": true, "high": true}
			lower := strings.ToLower(id)
			switch {
			case strings.HasPrefix(lower, "gemini-3-pro"):
				delete(levels, "medium")
			case strings.HasPrefix(lower, "gemini-3.1-flash-lite-image"):
				levels = map[string]bool{"minimal": true, "high": true}
			case strings.HasPrefix(lower, "gemini-3-flash"), strings.HasPrefix(lower, "gemini-3.5-flash"), strings.HasPrefix(lower, "gemini-3.6-flash"):
				levels["minimal"] = true
			}
			levels["off"] = strings.HasPrefix(lower, "gemini-2.5-flash")
		}
		delete(levels, "xhigh")
		delete(levels, "max")
	}
	if model["reasoning"] == true && len(levels) > 0 {
		model["thinkingLevelMap"] = declaredEffortLevels(levels)
	}
}

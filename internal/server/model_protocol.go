package server

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
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
	if idx := strings.LastIndex(u.Path, "/models/"); idx >= 0 {
		model, action, found := strings.Cut(u.Path[idx+len("/models/"):], ":")
		if found && model != "" && !strings.Contains(model, "/") && slices.Contains([]string{"generateContent", "streamGenerateContent", "countTokens"}, action) {
			u.Path = u.Path[:idx]
			u.RawPath = ""
			return u.String(), apiGemini
		}
	}
	return base, ""
}

type modelProtocolDetection struct {
	BaseURL    *url.URL
	API        string
	Models     []map[string]any
	BearerAuth bool
}

func (s *Server) detectModelProtocol(ctx context.Context, base, key, preferred string) (modelProtocolDetection, error) {
	base, explicit := modelProtocolRoute(base)
	apis := []string{apiChat, apiAnthropic, apiGemini}
	if explicit == apiAnthropic {
		apis = []string{apiAnthropic, apiChat}
	} else if explicit != "" {
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
	var nativeErr error
	nativeChecked := false
	for _, api := range apis {
		u, err := modelBaseURL(base, api)
		if err != nil {
			return modelProtocolDetection{}, err
		}
		catalogAPI := api
		profile := map[string]any{"baseUrl": u.String(), "api": api}
		if api == apiChat && explicit == apiAnthropic {
			profile["catalogFallbackAPI"] = apiAnthropic
		} else if explicit == "" && api == apiChat && (preferred == apiAnthropic || preferred == apiResponses) {
			profile["catalogFallbackAPI"] = preferred
		}
		models, err := s.discoverModels(ctx, profile, key)
		if catalogAPI == apiAnthropic {
			nativeChecked, nativeErr = true, err
		}
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
			if api == apiAnthropic {
				u, err = modelBaseURL(u.String(), apiAnthropic)
				if err != nil {
					return modelProtocolDetection{}, err
				}
			}
			bearerAuth := false
			if (catalogAPI == apiChat || catalogAPI == apiResponses) && (api == apiAnthropic || slices.ContainsFunc(models, func(model map[string]any) bool { return model["api"] == apiAnthropic })) {
				if !nativeChecked {
					probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
					_, nativeErr = s.discoverModels(probeCtx, map[string]any{"baseUrl": u.String(), "api": apiAnthropic}, key)
					cancel()
				}
				var status modelCatalogHTTPError
				bearerAuth = errors.As(nativeErr, &status) && (status == 401 || status == 403)
			}
			return modelProtocolDetection{BaseURL: u, API: api, Models: models, BearerAuth: bearerAuth}, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return modelProtocolDetection{}, fmt.Errorf("could not detect model API: %w", lastErr)
}

var fixedThinkingAlias = regexp.MustCompile(`(?i)(?:-(?:thinking|nothinking|high|medium|low|xhigh|max)(?:-(?:high|medium|low|xhigh|max|[0-9]+))?|@(?:thinking|effort):[^@]+)$`)
var adaptiveClaude = regexp.MustCompile(`^claude-(?:opus-(?:4-[678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5|(?:fable|mythos)-5(?:-[12])?)(?:-[0-9]{8})?$`)
var budgetClaude = regexp.MustCompile(`^claude-(?:3-7-sonnet|opus-4(?:-[015])?|sonnet-4(?:-[05])?|haiku-4-5)(?:-[0-9]{8})?$`)
var claudeSnapshot = regexp.MustCompile(`-[0-9]{8}$`)

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

// Use model and protocol capabilities when a compatible catalog omits them.
// Keep fixed aliases and explicitly advertised restrictions intact.
func claudeEffortLevels(id string) map[string]bool {
	if !adaptiveClaude.MatchString(id) {
		return nil
	}
	model := claudeSnapshot.ReplaceAllString(id, "")
	levels := map[string]bool{"low": true, "medium": true, "high": true, "max": true}
	levels["xhigh"] = model != "claude-opus-4-6" && model != "claude-sonnet-4-6"
	switch model {
	case "claude-opus-5-5", "claude-sonnet-5-5":
	default:
		levels["off"] = strings.Contains(model, "-4-") || model == "claude-opus-5" || model == "claude-sonnet-5" || model == "claude-haiku-5-5"
	}
	return levels
}

func describeCatalogModel(model, raw map[string]any, id, api, base string) {
	for _, field := range []string{"contextWindow", "context_length", "context_window", "contextLength", "inputTokenLimit", "max_input_tokens"} {
		if n, ok := raw[field].(float64); ok && n >= 1 && n <= 10000000 && float64(int(n)) == n {
			model["contextWindow"] = n
			break
		}
	}
	for _, field := range []string{"maxTokens", "max_output_tokens", "max_completion_tokens", "outputTokenLimit", "max_tokens"} {
		if n, ok := raw[field].(float64); ok && n >= 1 && n <= 1000000 && float64(int(n)) == n {
			model["maxTokens"] = n
			break
		}
	}
	for i, field := range modelLimitFields {
		if limit := bundledModelLimits[id][i]; model[field] == nil && limit > 0 {
			model[field] = limit
		}
	}
	catalogAPI := api
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
	if api == apiAnthropic {
		if u, err := modelBaseURL(base, apiAnthropic); err == nil && u.String() != base {
			model["baseUrl"] = u.String()
		}
	}
	if api == apiGemini && catalogAPI != apiGemini {
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
	adaptive := false
	if api == apiAnthropic {
		nativeThinking, _ := capabilities["thinking"].(map[string]any)
		nativeEffort, _ := capabilities["effort"].(map[string]any)
		if nativeThinking["supported"] == false || nativeEffort["supported"] == false {
			return
		}
		types, _ := nativeThinking["types"].(map[string]any)
		adaptiveMode, _ := types["adaptive"].(map[string]any)
		adaptive = adaptiveMode["supported"] == true
		if nativeEffort["supported"] == true {
			declared := make(map[string]bool)
			for _, level := range []string{"low", "medium", "high", "xhigh", "max"} {
				option, _ := nativeEffort[level].(map[string]any)
				if option["supported"] == true {
					declared[level] = true
				}
			}
			if len(declared) > 0 {
				levels = declared
				disabled, _ := types["disabled"].(map[string]any)
				if disabled["supported"] == true {
					levels["off"] = true
				}
			}
		}
	}
	knownClaudeLevels := claudeEffortLevels(id)
	if api == apiAnthropic && (knownClaudeLevels != nil ||
		(adaptive && len(levels) > 0) ||
		params["output_config.effort"]) {
		model["reasoning"] = true
		model["compat"] = map[string]any{"forceAdaptiveThinking": true}
		if len(levels) == 0 {
			levels = knownClaudeLevels
		} else if knownClaudeLevels != nil {
			for level := range levels {
				if !knownClaudeLevels[level] && !(level == "none" && knownClaudeLevels["off"]) {
					delete(levels, level)
				}
			}
		}
		if len(levels) == 0 {
			levels = map[string]bool{"low": true, "medium": true, "high": true}
		}
	} else if api == apiAnthropic && (budgetClaude.MatchString(id) || params["thinking.budget_tokens"]) {
		model["reasoning"] = true
		if len(levels) == 0 {
			levels = map[string]bool{"off": true, "minimal": true, "low": true, "medium": true, "high": true}
		}
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

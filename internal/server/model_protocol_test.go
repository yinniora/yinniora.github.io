package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDetectMixedModelCatalog(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" && r.Header.Get("x-api-key") == "testing" && r.Header.Get("Authorization") == "" {
			http.Error(w, "This gateway uses Bearer", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer testing" {
			http.Error(w, "unexpected request", 400)
			return
		}
		_, _ = io.WriteString(w, `{"data":[
			{"id":"claude-opus-5-5","supported_endpoint_types":["anthropic","openai"]},
			{"id":"claude-opus-5-5-thinking-max","supported_endpoint_types":["anthropic"],"supported_parameters":["effort","tools"]},
			{"id":"gpt-reasoning","supported_endpoint_types":["openai"],"supported_parameters":["reasoning_effort"],"supported_reasoning_efforts":["low","high"]},
			{"id":"gpt-responses","supported_endpoint_types":["openai responses"],"supported_parameters":["reasoning"]},
			{"id":"gemini-flash","supported_endpoint_types":["gemini"]}
		]}`)
	}))
	defer provider.Close()

	detection, err := (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", "")
	models := detection.Models
	if err != nil || detection.API != apiChat || !detection.BearerAuth || len(models) != 5 {
		t.Fatalf("detect catalog: api=%s models=%+v err=%v", detection.API, models, err)
	}
	if models[0]["api"] != apiAnthropic || models[0]["baseUrl"] != provider.URL || models[0]["reasoning"] != true {
		t.Fatalf("canonical Claude model lost native adaptive effort: %+v", models[0])
	}
	if models[1]["reasoning"] == true || models[1]["supportsTools"] != true {
		t.Fatalf("fixed reasoning alias: %+v", models[1])
	}
	if models[2]["baseUrl"] != provider.URL+"/v1beta" {
		t.Fatalf("wrong Gemini endpoint: %+v", models[2])
	}
	levels, _ := models[3]["thinkingLevelMap"].(map[string]any)
	if models[3]["reasoning"] != true || levels["low"] != "low" || levels["medium"] != nil {
		t.Fatalf("wrong advertised effort handling: %+v", models[3])
	}
	if models[4]["api"] != apiResponses || models[4]["reasoning"] != true {
		t.Fatalf("wrong Responses configuration: %+v", models[4])
	}
	detection, err = (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", apiAnthropic)
	models = detection.Models
	if err != nil || detection.API != apiAnthropic || !detection.BearerAuth || len(models) != 5 || models[2]["api"] != apiGemini || models[4]["api"] != apiResponses {
		t.Fatalf("existing Claude profile lost mixed catalog routes: api=%s models=%+v err=%v", detection.API, models, err)
	}
}

func TestClaudeEffortDependsOnExactModelAndProtocol(t *testing.T) {
	for _, c := range []struct {
		name, id, api       string
		reasoning, adaptive bool
		off, max            bool
	}{
		{"opus adaptive", "claude-opus-5-5", apiAnthropic, true, true, false, true},
		{"dated adaptive", "claude-opus-5-5-20261101", apiAnthropic, true, true, false, true},
		{"legacy budget", "claude-sonnet-4-5-20250929", apiAnthropic, true, false, true, false},
		{"fixed variant", "claude-opus-5-5-thinking-high", apiAnthropic, false, false, false, false},
		{"chat protocol", "claude-opus-5-5", apiChat, false, false, false, false},
		{"arbitrary alias", "private-claude-opus-5-5", apiAnthropic, false, false, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			model := map[string]any{}
			describeCatalogModel(model, nil, c.id, c.api, "https://example.invalid")
			compat, _ := model["compat"].(map[string]any)
			levels, _ := model["thinkingLevelMap"].(map[string]any)
			if (model["reasoning"] == true) != c.reasoning || (compat["forceAdaptiveThinking"] == true) != c.adaptive ||
				(levels["off"] != nil) != c.off || (levels["max"] != nil) != c.max {
				t.Fatalf("incorrect model capabilities: %+v", model)
			}
		})
	}
}

func TestEffortFromNativeGeminiAndAdvertisedResponseLevels(t *testing.T) {
	gemini := map[string]any{}
	describeCatalogModel(gemini, map[string]any{"thinking": true}, "gemini-3-pro-preview", apiGemini, "https://example.invalid/v1beta")
	levels, _ := gemini["thinkingLevelMap"].(map[string]any)
	if gemini["reasoning"] != true || levels["low"] != "low" || levels["high"] != "high" || levels["medium"] != nil || levels["off"] != nil {
		t.Fatalf("wrong Gemini levels: %+v", gemini)
	}

	responses := map[string]any{}
	describeCatalogModel(responses, map[string]any{
		"supported_reasoning_efforts": []any{"none", "medium", "max"},
	}, "reasoning-model", apiResponses, "https://example.invalid/v1")
	levels, _ = responses["thinkingLevelMap"].(map[string]any)
	if responses["reasoning"] != true || levels["max"] != "max" || levels["off"] != "none" || levels["low"] != nil {
		t.Fatalf("wrong Responses levels: %+v", responses)
	}
}

func TestEffortFromStructuredProviderCapabilities(t *testing.T) {
	model := map[string]any{}
	describeCatalogModel(model, map[string]any{
		"capabilities": map[string]any{"reasoning": map[string]any{
			"supported": true, "toggle": true, "effort": []any{"default", "low", "high"},
		}},
	}, "provider-model", apiChat, "https://example.invalid/v1")
	levels, _ := model["thinkingLevelMap"].(map[string]any)
	if model["reasoning"] != true || levels["off"] != "none" || levels["low"] != "low" ||
		levels["high"] != "high" || levels["medium"] != nil {
		t.Fatalf("incorrect declared effort mapping: %+v", model)
	}
}

func TestAnthropicCatalogDeclaresEffortAndLimitsForAnAlias(t *testing.T) {
	model := map[string]any{}
	describeCatalogModel(model, map[string]any{
		"max_input_tokens": float64(1000000),
		"max_tokens":       float64(128000),
		"capabilities": map[string]any{
			"thinking": map[string]any{"supported": true, "types": map[string]any{
				"adaptive": map[string]any{"supported": true},
				"disabled": map[string]any{"supported": false},
			}},
			"effort": map[string]any{"supported": true,
				"low": map[string]any{"supported": true}, "high": map[string]any{"supported": true},
				"xhigh": map[string]any{"supported": false}},
		},
	}, "gateway-alias", apiAnthropic, "https://example.invalid")
	levels, _ := model["thinkingLevelMap"].(map[string]any)
	if model["contextWindow"] != float64(1000000) || model["maxTokens"] != float64(128000) ||
		model["reasoning"] != true || levels["low"] != "low" || levels["high"] != "high" ||
		levels["medium"] != nil || levels["xhigh"] != nil || levels["off"] != nil {
		t.Fatalf("incorrect native catalog capabilities: %+v", model)
	}
}

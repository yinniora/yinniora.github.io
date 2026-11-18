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

	_, api, models, err := (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", "")
	if err != nil || api != apiChat || len(models) != 5 {
		t.Fatalf("detect catalog: api=%s models=%+v err=%v", api, models, err)
	}
	if models[0]["api"] != apiAnthropic || models[0]["reasoning"] == true {
		t.Fatalf("gateway's native route alone doesn't confirm dynamic effort: %+v", models[0])
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
	_, api, models, err = (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", apiAnthropic)
	if err != nil || api != apiAnthropic || len(models) != 5 || models[2]["api"] != apiGemini || models[4]["api"] != apiResponses {
		t.Fatalf("existing Claude profile lost mixed catalog routes: api=%s models=%+v err=%v", api, models, err)
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

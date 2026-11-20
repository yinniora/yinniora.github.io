package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type modelCatalogTransport func(*http.Request) (*http.Response, error)

func (transport modelCatalogTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestDiscoverModelsUsesPublicLimitsForNewCanonicalModels(t *testing.T) {
	var requests atomic.Int32
	s := &Server{}
	s.nativeModelLimits.client = &http.Client{Transport: modelCatalogTransport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		if r.URL.String() != "https://pi.dev/api/models/providers/google?types=chat" ||
			r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "" {
			t.Errorf("public model lookup received unexpected arguments: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`[
			{"id":"gemini-next-verified","contextWindow":2000000,"maxTokens":1048576}
		]`))}, nil
	})}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"data":[
			{"id":"gemini-next-verified","max_output_tokens":65536},
			{"id":"gemini-next-verified-high"},
			{"id":"unknown-custom-model"}
		]}`)
	}))
	defer gateway.Close()
	models, err := s.discoverModels(context.Background(), map[string]any{"api": apiChat, "baseUrl": gateway.URL}, "fixture-key")
	if err != nil || len(models) != 3 {
		t.Fatalf("catalog discovery failed: models=%v, error=%v", models, err)
	}
	if models[0]["contextWindow"] != 2000000 || models[0]["maxTokens"] != float64(65536) ||
		models[1]["maxTokens"] != 1048576 || models[2]["contextWindow"] != nil || requests.Load() != 1 {
		t.Fatalf("model or route limits were overridden incorrectly: models=%v, public requests=%d", models, requests.Load())
	}
}

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

	detection, err := (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", "", "")
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
	detection, err = (&Server{}).detectModelProtocol(context.Background(), provider.URL, "testing", apiAnthropic, "")
	models = detection.Models
	if err != nil || detection.API != apiAnthropic || !detection.BearerAuth || len(models) != 5 || models[2]["api"] != apiGemini || models[4]["api"] != apiResponses {
		t.Fatalf("existing Claude profile lost mixed catalog routes: api=%s models=%+v err=%v", detection.API, models, err)
	}
}

func TestDetectNativeRoutesForPlainGatewayCatalog(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/mount/v1/models" {
			_, _ = io.WriteString(w, `{"data":[
				{"id":"claude-opus-5-5"},
				{"id":"gpt-5.4"},
				{"id":"gpt-chat-only","supported_endpoint_types":["openai"]},
				{"id":"gemini-3-pro-preview"},
				{"id":"other-chat"}
			]}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || string(body) != "{}" {
			t.Errorf("unexpected probe request on %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/mount/v1/messages":
			if r.Header.Get("x-api-key") != "fixture" || r.Header.Get("anthropic-version") == "" {
				t.Error("Claude probe used incorrect credentials")
			}
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"type":"invalid_request","message":"模型不能为空 (model)"}}`)
		case "/mount/v1/responses":
			if r.Header.Get("Authorization") != "Bearer fixture" {
				t.Error("Responses probe used incorrect credentials")
			}
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","param":"input","message":"missing input"}}`)
		case "/mount/v1beta/models/gemini-3-pro-preview:countTokens":
			if r.Header.Get("x-goog-api-key") != "fixture" {
				t.Error("Gemini probe used incorrect credentials")
			}
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"status":"INVALID_ARGUMENT","message":"contents is required"}}`)
		default:
			t.Errorf("probed unexpected URL %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	base := provider.URL + "/mount/v1"
	detection, err := (&Server{}).detectModelProtocol(context.Background(), base, "fixture", "", "")
	if err != nil || detection.API != apiChat || detection.BearerAuth || len(detection.Models) != 5 {
		t.Fatalf("unexpected detection: %+v, %v", detection, err)
	}
	want := map[string][2]string{
		"claude-opus-5-5":      {apiAnthropic, provider.URL + "/mount"},
		"gpt-5.4":              {apiResponses, base},
		"gpt-chat-only":        {apiChat, ""},
		"gemini-3-pro-preview": {apiGemini, provider.URL + "/mount/v1beta"},
		"other-chat":           {apiChat, ""},
	}
	for _, model := range detection.Models {
		id := model["id"].(string)
		baseURL, _ := model["baseUrl"].(string)
		if got := [2]string{model["api"].(string), baseURL}; got != want[id] {
			t.Errorf("%s route: got %q, want %q", id, got, want[id])
		}
	}
	locked, err := (&Server{}).detectModelProtocol(context.Background(), base+"/chat/completions", "fixture", "", "")
	if err != nil || locked.API != apiChat || len(locked.Models) != 5 {
		t.Fatalf("explicit Chat Completions route was changed: %+v %v", locked, err)
	}
	for _, model := range locked.Models {
		if model["api"] != apiChat {
			t.Errorf("explicit protocol was not respected: %+v", model)
		}
	}
}

func TestNativeRouteValidationRequiresProtocolEvidence(t *testing.T) {
	for _, item := range []struct {
		status int
		body   string
	}{
		{200, `{"error":{"type":"invalid_request","message":"model is required"}}`},
		{400, `{"error":{"type":"invalid_request_error","message":"this group does not support model traffic"}}`},
		{400, `{"error":{"type":"invalid_request_error","message":"model is not supported"}}`},
		{400, `{"message":"model is required"}`},
		{401, `{"error":{"type":"invalid_request","message":"model is required"}}`},
		{404, `{"error":{"type":"invalid_request","message":"model is required"}}`},
		{400, `<html>missing model</html>`},
	} {
		if nativeRouteValidation(item.status, []byte(item.body), apiAnthropic) {
			t.Errorf("accepted %d %s as native protocol evidence", item.status, item.body)
		}
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
		{"chat protocol keeps official levels", "claude-opus-5-5", apiChat, true, false, false, true},
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

func TestBundledModelLimitsFillGapsInCatalog(t *testing.T) {
	model := map[string]any{"id": "claude-opus-5-5"}
	describeCatalogModel(model, nil, "claude-opus-5-5", apiAnthropic, "https://example.invalid")
	if model["contextWindow"] != 1000000 || model["maxTokens"] != 128000 {
		t.Fatalf("unexpected Opus 5.5 limits: %+v", model)
	}
	model["contextWindow"] = 200000
	public := publicModel(model, "provider", "label")
	if public["contextWindow"] != 200000 || public["defaultContextWindow"] != 1000000 ||
		public["defaultMaxTokens"] != 128000 {
		t.Fatalf("model defaults must remain available after editing: %+v", public)
	}
	alias := map[string]any{}
	describeCatalogModel(alias, nil, "private-claude-opus-5-5-thinking-max", apiAnthropic, "https://example.invalid")
	if alias["contextWindow"] != nil || alias["maxTokens"] != nil {
		t.Fatalf("inferred unannounced alias limits: %+v", alias)
	}
	thinkingVariant := map[string]any{}
	describeCatalogModel(thinkingVariant, nil, "gemini-4-carbon-high", apiGemini, "https://example.invalid")
	if thinkingVariant["contextWindow"] != 1048576 || thinkingVariant["maxTokens"] != 32768 {
		t.Fatalf("did not use the canonical Gemini defaults for its fixed-effort variant: %+v", thinkingVariant)
	}
	limited := map[string]any{}
	describeCatalogModel(limited, map[string]any{"max_tokens": float64(64000)}, "claude-opus-5-5", apiAnthropic, "https://example.invalid")
	if limited["contextWindow"] != 1000000 || limited["maxTokens"] != float64(64000) {
		t.Fatalf("ignored an advertised limit: %+v", limited)
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

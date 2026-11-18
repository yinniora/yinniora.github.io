package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRepairSavedModelEndpointsSeparatesMixedGatewayPaths(t *testing.T) {
	dir := t.TempDir()
	modelsPath := filepath.Join(dir, "models.json")
	raw := []byte(`{"providers":{
		"relay":{"baseUrl":"https://cf.api.fan/proxy/v1","api":"openai-completions","apiKey":"fixture-key","models":[{"id":"claude","api":"anthropic-messages","reasoning":true},{"id":"openai"}]},
		"native":{"baseUrl":"https://example.invalid/anthropic/v1/messages","api":"anthropic-messages","models":[{"id":"native"},{"id":"response","api":"openai-responses"},{"id":"gemini","api":"google-generative-ai"}]}
	}}`)
	if err := writePrivateModelFile(modelsPath, raw); err != nil {
		t.Fatal(err)
	}
	if err := RepairSavedModelEndpoints(dir); err != nil {
		t.Fatal(err)
	}
	_, providers, _, err := readModelConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	relay := providers["relay"].(map[string]any)
	models := configuredModels(relay)
	if relay["baseUrl"] != "https://cf.api.fan/proxy/v1" || relay["apiKey"] != "fixture-key" || relay["authHeader"] != true ||
		models[0]["baseUrl"] != "https://cf.api.fan/proxy" || models[0]["reasoning"] != true || models[1]["baseUrl"] != nil {
		t.Fatalf("mixed gateway route or authentication was not repaired: %+v", relay)
	}
	native := providers["native"].(map[string]any)
	models = configuredModels(native)
	if native["baseUrl"] != "https://example.invalid/anthropic" || native["authHeader"] != nil || models[0]["baseUrl"] != nil ||
		models[1]["baseUrl"] != "https://example.invalid/anthropic/v1" || models[2]["baseUrl"] != "https://example.invalid/anthropic/v1beta" {
		t.Fatalf("versioned routes or mount prefix were incorrect: %+v", native)
	}
	updated, _ := os.ReadFile(modelsPath)
	if err := RepairSavedModelEndpoints(dir); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.ReadFile(modelsPath); !bytes.Equal(updated, again) {
		t.Fatal("route upgrade is not idempotent")
	}
}

func TestAnthropicDiscoveryKeepsVersionInCatalogOnly(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/gateway/v1/models" || r.Header.Get("x-api-key") != "fixture-secret" {
			t.Error("wrong catalog route or key header")
		}
		w.Write([]byte(`{"data":[{"id":"claude-fixture","type":"model","display_name":"Claude","created_at":"2026-01-01T00:00:00Z"}]}`))
	}))
	defer service.Close()
	detection, err := (&Server{}).detectModelProtocol(context.Background(), service.URL+"/gateway/v1/messages", "fixture-secret", "")
	if err != nil || detection.API != apiAnthropic || detection.BaseURL.String() != service.URL+"/gateway" || detection.BearerAuth || len(detection.Models) != 1 {
		t.Fatalf("expected an unversioned runtime base and an Anthropic model, got %+v err=%v", detection, err)
	}
}

func TestExplicitAnthropicURLCanUseBearerOnOtherGateways(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/relay/v1/models" {
			t.Error("unexpected model discovery route")
		}
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			http.Error(w, "Bearer required", http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"data":[{"id":"claude-fixture"}]}`))
	}))
	defer service.Close()
	detection, err := (&Server{}).detectModelProtocol(context.Background(), service.URL+"/relay/v1/messages", "test-secret", "")
	if err != nil || detection.API != apiAnthropic || detection.BaseURL.String() != service.URL+"/relay" || !detection.BearerAuth {
		t.Fatalf("Bearer-only gateway was not detected: %+v err=%v", detection, err)
	}
}

func TestModelBasesRespectProtocolAndExistingVersion(t *testing.T) {
	for _, test := range []struct{ raw, api, path string }{
		{"/proxy/v1/chat/completions", apiChat, "/proxy/v1"},
		{"/proxy/v1/responses", apiResponses, "/proxy/v1"},
		{"/proxy/v1/messages", apiAnthropic, "/proxy"},
		{"/proxy/v1/v1/messages", apiAnthropic, "/proxy"},
		{"/proxy/anthropic", apiAnthropic, "/proxy/anthropic"},
		{"/proxy/v1beta/models/fixture:streamGenerateContent", apiGemini, "/proxy/v1beta"},
		{"/proxy/v1", apiGemini, "/proxy/v1"},
	} {
		u, err := modelBaseURL("https://example.invalid"+test.raw, test.api)
		if err != nil || u.Path != test.path {
			t.Errorf("%s base %q = %v (%v), want path %q", test.api, test.raw, u, err, test.path)
		}
	}

	model := map[string]any{}
	describeCatalogModel(model, map[string]any{}, "gemini-native", apiGemini, "https://example.invalid/v1")
	if model["baseUrl"] != nil {
		t.Fatal("Gemini models discovered on a native v1 endpoint must retain that version")
	}
}

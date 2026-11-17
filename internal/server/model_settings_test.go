package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func modelSettingsCall(t *testing.T, s *Server, body any) (int, map[string]any, string) {
	t.Helper()
	method := "GET"
	raw := ""
	if body != nil {
		method = "POST"
		data, _ := json.Marshal(body)
		raw = string(data)
	}
	w := httptest.NewRecorder()
	s.handleModelSettings(w, httptest.NewRequest(method, "/api/model-settings", strings.NewReader(raw)))
	var data map[string]any
	if json.Unmarshal(w.Body.Bytes(), &data) != nil {
		t.Fatal("invalid response")
	}
	return w.Code, data, w.Body.String()
}

func TestModelKeysRefreshMultiApplyRemoveAndPrivacy(t *testing.T) {
	s := newTestServer(t)
	const secret = "fixture-key-do-not-return"
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("wrong discovery request")
		}
		w.Write([]byte(`{"data":[{"id":"chat-one"},{"id":"chat-two"}]}`))
	}))
	defer service.Close()
	_, data, _ := modelSettingsCall(t, s, nil)
	code, data, text := modelSettingsCall(t, s, map[string]any{"action": "add", "revision": data["revision"], "label": "Personal New API", "baseUrl": service.URL, "api": "openai-completions", "key": secret})
	if code != 200 || strings.Contains(text, secret) {
		t.Fatal("key was not saved privately", code, text)
	}
	profile := data["profiles"].([]any)[0].(map[string]any)
	id := profile["id"]
	if len(profile["applied"].([]any)) != 0 {
		t.Fatal("adding a key auto-applied models")
	}
	code, data, text = modelSettingsCall(t, s, map[string]any{"action": "refresh", "id": id, "revision": data["revision"]})
	if code != 200 || strings.Contains(text, secret) {
		t.Fatal("refresh failed or leaked credentials", code)
	}
	profile = data["profiles"].([]any)[0].(map[string]any)
	if len(profile["available"].([]any)) != 2 || len(profile["applied"].([]any)) != 0 {
		t.Fatal("refresh should list without applying")
	}
	stale := data["revision"]
	code, data, _ = modelSettingsCall(t, s, map[string]any{"action": "apply", "id": id, "revision": data["revision"], "modelIds": []string{"chat-one", "chat-two"}, "vision": true})
	if code != 200 {
		t.Fatal("multi-select apply failed", data)
	}
	models, err := s.appliedModels([]map[string]any{{"provider": id, "id": "removed-cache-entry", "headers": map[string]any{"Authorization": secret}}})
	if err != nil || len(models) != 2 || models[0]["providerLabel"] != "Personal New API" {
		t.Fatal("picker did not use applied models", models, err)
	}
	serialized, _ := json.Marshal(models)
	if strings.Contains(string(serialized), secret) {
		t.Fatal("picker leaked credentials")
	}
	code, _, _ = modelSettingsCall(t, s, map[string]any{"action": "remove-model", "id": id, "revision": stale, "modelId": "chat-one"})
	if code != 409 {
		t.Fatal("stale mutation overwrote model settings")
	}
	code, data, _ = modelSettingsCall(t, s, map[string]any{"action": "remove-model", "id": id, "revision": data["revision"], "modelId": "chat-one"})
	if code != 200 {
		t.Fatal("remove failed")
	}
	models, _ = s.appliedModels(nil)
	if len(models) != 1 || models[0]["id"] != "chat-two" {
		t.Fatal("removed model still selectable")
	}
	_, providers, _, _ := readModelConfig(s.agentDir)
	if s.modelProfileKey(id.(string), providers[id.(string)].(map[string]any)) != secret {
		t.Fatal("removing a model removed its key")
	}
	st, _ := os.Stat(filepath.Join(s.agentDir, "models.json"))
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		t.Fatal("key file is not private")
	}
}

func TestModelDiscoveryDoesNotForwardKeysThroughRedirects(t *testing.T) {
	s := newTestServer(t)
	received := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received = true }))
	defer other.Close()
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer service.Close()
	_, err := s.discoverModels(context.Background(), map[string]any{"baseUrl": service.URL, "api": "openai-completions"}, "private-fixture")
	if err == nil || received {
		t.Fatal("discovery forwarded a credential to a redirect target")
	}
}

func TestExistingProvidersAndModelMetadataArePreserved(t *testing.T) {
	s := newTestServer(t)
	models := `{"other":{"keep":true},"providers":{"existing":{"name":"Existing key","api":"anthropic-messages","baseUrl":"https://example.invalid/v1","models":[{"id":"kept","input":["text","image"],"reasoning":true,"contextWindow":200000,"compat":{"keep":true}}]}}}`
	auth := `{"existing":{"type":"api_key","key":"existing-private-key"}}`
	os.WriteFile(filepath.Join(s.agentDir, "models.json"), []byte(models), 0600)
	os.WriteFile(filepath.Join(s.agentDir, "auth.json"), []byte(auth), 0600)
	_, data, text := modelSettingsCall(t, s, nil)
	if strings.Contains(text, "existing-private-key") {
		t.Fatal("existing key leaked")
	}
	profile := data["profiles"].([]any)[0].(map[string]any)
	if profile["hasKey"] != true || len(profile["applied"].([]any)) != 1 {
		t.Fatal("existing provider not imported")
	}
	code, _, _ := modelSettingsCall(t, s, map[string]any{"action": "add", "revision": data["revision"], "label": "Second", "baseUrl": "https://example.invalid", "api": "openai-responses", "key": "new-private-key"})
	if code != 200 {
		t.Fatal("second key failed")
	}
	config, providers, _, _ := readModelConfig(s.agentDir)
	if config["other"] == nil || configuredModels(providers["existing"].(map[string]any))[0]["compat"] == nil {
		t.Fatal("unrelated settings lost")
	}
	raw, _ := os.ReadFile(filepath.Join(s.agentDir, "auth.json"))
	if string(raw) != auth {
		t.Fatal("existing auth storage changed")
	}
}

func TestDiscoveryProtocolHeadersAndPagination(t *testing.T) {
	for _, api := range []string{"anthropic-messages", "google-generative-ai"} {
		t.Run(api, func(t *testing.T) {
			s := newTestServer(t)
			calls := 0
			service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Header.Get("Authorization") != "" {
					t.Error("unexpected Bearer header")
				}
				if api == "anthropic-messages" {
					if r.Header.Get("x-api-key") != "fixture" {
						t.Error("missing Anthropic key")
					}
					if calls == 1 {
						w.Write([]byte(`{"data":[{"id":"claude-a"}],"has_more":true,"last_id":"claude-a"}`))
					} else {
						if r.URL.Query().Get("after_id") != "claude-a" {
							t.Error("missing cursor")
						}
						w.Write([]byte(`{"data":[{"id":"claude-b"}],"has_more":false}`))
					}
				} else {
					if r.Header.Get("x-goog-api-key") != "fixture" {
						t.Error("missing Gemini key")
					}
					if calls == 1 {
						w.Write([]byte(`{"models":[{"name":"models/gemini-a","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next"}`))
					} else {
						if r.URL.Query().Get("pageToken") != "next" {
							t.Error("missing cursor")
						}
						w.Write([]byte(`{"models":[{"name":"models/embedding","supportedGenerationMethods":["embedContent"]},{"name":"models/gemini-b","supportedGenerationMethods":["generateContent"]}]}`))
					}
				}
			}))
			defer service.Close()
			list, err := s.discoverModels(context.Background(), map[string]any{"baseUrl": service.URL, "api": api}, "fixture")
			if err != nil || len(list) != 2 || calls != 2 {
				t.Fatal("protocol list/pagination failed", err, len(list), calls)
			}
		})
	}
}

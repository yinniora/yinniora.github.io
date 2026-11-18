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

func TestRemoveModelKeyPrunesCredentialModelsAndStaleCatalog(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		label := "inline"
		if legacy {
			label = "legacy"
		}
		t.Run(label, func(t *testing.T) {
			s := newTestServer(t)
			profile := map[string]any{"api": "anthropic-messages", "baseUrl": "https://example.invalid/v1", "models": []any{map[string]any{"id": "removed"}}}
			auth := map[string]any{"keep": map[string]any{"type": "api_key", "key": "keep-fixture"}}
			if legacy {
				auth["target"] = map[string]any{"type": "api_key", "key": "remove-fixture"}
			} else {
				profile["apiKey"] = "remove-fixture"
			}
			if err := writeModelConfig(s.agentDir, map[string]any{"providers": map[string]any{"target": profile, "keep": map[string]any{"baseUrl": "https://example.invalid/v1", "api": "anthropic-messages"}}}); err != nil {
				t.Fatal(err)
			}
			authPath := filepath.Join(s.agentDir, "auth.json")
			rawAuth, _ := json.Marshal(auth)
			if err := os.WriteFile(authPath, rawAuth, 0600); err != nil {
				t.Fatal(err)
			}
			s.modelCatalogs = map[string]modelCatalog{"target": {Signature: "old"}}
			code, _, _ := modelSettingsCall(t, s, map[string]any{"action": "remove-key", "id": "target", "revision": "stale"})
			if code != 409 {
				t.Fatal("removed a key from a stale settings page")
			}
			_, data, _ := modelSettingsCall(t, s, nil)
			code, data, response := modelSettingsCall(t, s, map[string]any{"action": "remove-key", "id": "target", "revision": data["revision"]})
			if code != 200 || len(data["profiles"].([]any)) != 1 || strings.Contains(response, "fixture") {
				t.Fatal("removal did not return only the remaining profile", code)
			}
			_, providers, _, _ := readModelConfig(s.agentDir)
			if providers["target"] != nil || providers["keep"] == nil || s.modelCatalogs["target"].Signature != "" {
				t.Fatal("wrong profile or catalog removed")
			}
			authAfter, _ := os.ReadFile(authPath)
			if strings.Contains(string(authAfter), "remove-fixture") || !strings.Contains(string(authAfter), "keep-fixture") || (!legacy && string(authAfter) != string(rawAuth)) {
				t.Fatal("private credentials were not scoped to the removed profile")
			}
			models, err := s.appliedModels([]map[string]any{{"provider": "target", "id": "removed"}, {"provider": "unrelated", "id": "kept"}})
			if err != nil || len(models) != 1 || models[0]["id"] != "kept" {
				t.Fatal("stale deleted provider reappeared in model picker", err)
			}
		})
	}
}

func TestRemoveModelKeyRestoresLegacyCredentialIfConfigSaveFails(t *testing.T) {
	agent := t.TempDir()
	path := filepath.Join(agent, "auth.json")
	original := `{"target":{"type":"api_key","key":"fixture"}}`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(agent, "models.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := deleteModelKey(agent, "target", map[string]any{"providers": map[string]any{}}); err == nil {
		t.Fatal("deletion unexpectedly replaced a directory")
	}
	if result, err := os.ReadFile(path); err != nil || string(result) != original {
		t.Fatal("credential was lost after a failed provider deletion", err)
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

func TestRemoveModelClearsLocalOverridesAndStartupSelection(t *testing.T) {
	s := newTestServer(t)
	profile := map[string]any{
		"api": apiChat, "baseUrl": "https://example.invalid/v1", "apiKey": "fixture",
		"models": []any{
			map[string]any{"id": "target", "reasoning": true, "thinkingLevelMap": map[string]any{"high": "high"}},
			map[string]any{"id": "keep"},
		},
		"modelOverrides": map[string]any{"target": map[string]any{"maxTokens": 512}, "keep": map[string]any{"maxTokens": 1024}},
	}
	if err := writeModelConfig(s.agentDir, map[string]any{"providers": map[string]any{"provider": profile}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.agentDir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"defaultProvider":"provider","defaultModel":"target","defaultThinkingLevel":"low","enabledModels":["provider/target:high","provider/target","provider/keep","other/target","target"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, current, _ := modelSettingsCall(t, s, nil)
	code, _, _ := modelSettingsCall(t, s, map[string]any{"action": "remove-model", "id": "provider", "modelId": "target", "revision": current["revision"]})
	if code != 200 {
		t.Fatalf("remove model: HTTP %d", code)
	}
	_, providers, _, err := readModelConfig(s.agentDir)
	if err != nil {
		t.Fatal(err)
	}
	p := providers["provider"].(map[string]any)
	models := configuredModels(p)
	overrides := p["modelOverrides"].(map[string]any)
	if len(models) != 1 || models[0]["id"] != "keep" || overrides["target"] != nil || overrides["keep"] == nil || p["apiKey"] != "fixture" {
		t.Fatalf("incorrect config cleanup: %+v", p)
	}
	data, err := os.ReadFile(path)
	var settings map[string]any
	if err != nil || json.Unmarshal(data, &settings) != nil {
		t.Fatal("could not read cleaned settings")
	}
	enabled, _ := json.Marshal(settings["enabledModels"])
	if settings["defaultModel"] != nil || settings["defaultProvider"] != nil || settings["defaultThinkingLevel"] != "low" ||
		string(enabled) != `["provider/keep","other/target","target"]` {
		t.Fatalf("incorrect startup cleanup: %+v", settings)
	}
}

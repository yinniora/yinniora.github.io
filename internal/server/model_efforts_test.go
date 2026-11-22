package server

import (
	"net/url"
	"testing"
)

func TestOpenAIReasoningFromIDOnlyCatalogAndSavedModels(t *testing.T) {
	saved := []any{}
	for _, id := range []string{"gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-astra-2026-11-03"} {
		model := map[string]any{"id": id}
		describeCatalogModel(model, nil, id, apiResponses, "https://api.openai.com/v1")
		assertGPT62Efforts(t, model)
		saved = append(saved, map[string]any{"id": id, "api": apiResponses, "reasoning": false})
	}
	if !upgradeOfficialEfforts(map[string]any{"openai": map[string]any{"api": apiChat, "models": saved}}) {
		t.Fatal("previously applied models were not upgraded")
	}
	for _, model := range saved {
		assertGPT62Efforts(t, model.(map[string]any))
	}
	unknown := map[string]any{"id": "gpt-image-test"}
	describeCatalogModel(unknown, nil, "gpt-image-test", apiResponses, "https://api.openai.com/v1")
	if unknown["reasoning"] == true {
		t.Fatal("an unknown model gained reasoning controls")
	}
}

func assertGPT62Efforts(t *testing.T, model map[string]any) {
	t.Helper()
	levels, _ := model["thinkingLevelMap"].(map[string]any)
	if model["api"] != apiResponses || model["reasoning"] != true || levels["off"] != nil || levels["minimal"] != nil ||
		levels["low"] != "low" || levels["medium"] != "medium" || levels["high"] != "high" || levels["xhigh"] != "xhigh" || levels["max"] != "max" {
		t.Fatalf("incorrect GPT-6.2 capability: %+v", model)
	}
}

func TestOfficialOpenAIRequiresItsHTTPSHost(t *testing.T) {
	for _, input := range []string{"https://api.openai.com", "https://API.OPENAI.COM:443/v1"} {
		u, _ := url.Parse(input)
		if !isOfficialOpenAI(u) {
			t.Fatalf("did not recognize %s", input)
		}
	}
	for _, input := range []string{"https://api.openai.com.example.org/v1", "https://api.openai.com:444/v1", "http://api.openai.com/v1"} {
		u, _ := url.Parse(input)
		if isOfficialOpenAI(u) {
			t.Fatalf("treated %s as official", input)
		}
	}
}

func TestOfficialEffortsFollowTheModelNotTheRelay(t *testing.T) {
	providers := map[string]any{
		"relay": map[string]any{"api": apiChat, "models": []any{
			map[string]any{"id": "claude-opus-5-5", "reasoning": false},
			map[string]any{"id": "gpt-5.5-20260101"},
			map[string]any{"id": "claude-opus-5-5-thinking-high", "reasoning": false},
			map[string]any{"id": "private-model", "reasoning": false},
			map[string]any{"id": "claude-sonnet-4-5", "reasoning": true, "thinkingLevelMap": map[string]any{"high": "high"}},
		}},
		"native": map[string]any{"api": apiAnthropic, "models": []any{
			map[string]any{"id": "claude-opus-5-5"},
		}},
	}
	if !upgradeOfficialEfforts(providers) {
		t.Fatal("known models were not upgraded")
	}
	relay := configuredModels(providers["relay"].(map[string]any))
	opus := relay[0]
	levels := opus["thinkingLevelMap"].(map[string]any)
	compat := opus["compat"].(map[string]any)
	if opus["reasoning"] != true || levels["off"] != nil || levels["max"] != "max" || levels["low"] != "low" ||
		compat["supportsReasoningEffort"] != true || compat["forceAdaptiveThinking"] != nil {
		t.Fatalf("relay Claude did not get official levels: %+v", opus)
	}
	gpt := relay[1]["thinkingLevelMap"].(map[string]any)
	if relay[1]["reasoning"] != true || gpt["off"] != "none" || gpt["xhigh"] != "xhigh" || gpt["max"] != nil {
		t.Fatalf("dated GPT snapshot did not get official levels: %+v", relay[1])
	}
	if relay[2]["reasoning"] != false || relay[3]["reasoning"] != false {
		t.Fatalf("fixed alias or unknown model changed: %+v %+v", relay[2], relay[3])
	}
	if len(relay[4]["thinkingLevelMap"].(map[string]any)) != 1 {
		t.Fatalf("explicit level map was overwritten: %+v", relay[4])
	}
	native := configuredModels(providers["native"].(map[string]any))[0]
	if native["compat"].(map[string]any)["forceAdaptiveThinking"] != true {
		t.Fatalf("native Claude lost adaptive thinking: %+v", native)
	}
	if upgradeOfficialEfforts(providers) {
		t.Fatal("upgrade is not idempotent")
	}
}

package server

import "testing"

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

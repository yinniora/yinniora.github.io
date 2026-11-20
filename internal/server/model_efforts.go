package server

import (
	_ "embed"
	"encoding/json"
	"regexp"
)

// Official thinking levels per model ID, generated from Pi's bundled catalog by
// scripts/update_model_efforts.mjs. A relay that serves a known model gets the
// levels the model's own API defines, without probing the relay.
//
//go:embed model_efforts.json
var bundledModelEffortsJSON []byte

type officialEffort struct {
	Levels   map[string]string `json:"levels"`
	Adaptive bool              `json:"adaptive"`
}

var bundledModelEfforts = func() map[string]officialEffort {
	var models map[string]officialEffort
	if err := json.Unmarshal(bundledModelEffortsJSON, &models); err != nil {
		panic(err)
	}
	return models
}()

var modelDateSnapshot = regexp.MustCompile(`-[0-9]{8}$`)

var piThinkingLevels = [...]string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func officialEffortForID(id string) (officialEffort, bool) {
	if id == "" || fixedThinkingAlias.MatchString(id) {
		return officialEffort{}, false
	}
	if effort, ok := bundledModelEfforts[id]; ok {
		return effort, true
	}
	effort, ok := bundledModelEfforts[modelDateSnapshot.ReplaceAllString(id, "")]
	return effort, ok
}

// applyOfficialEffort marks a known model as reasoning and records its official
// levels in Pi's thinkingLevelMap format. It returns false for unknown IDs and
// fixed-effort aliases, which keep their current settings.
func applyOfficialEffort(model map[string]any, id, api string) bool {
	effort, ok := officialEffortForID(id)
	if !ok || len(effort.Levels) == 0 {
		return false
	}
	levelMap := map[string]any{}
	for _, level := range piThinkingLevels {
		value, supported := effort.Levels[level]
		switch {
		case !supported:
			levelMap[level] = nil
		case level == "off" && value == "off":
			// Pi sends no reasoning parameter for an unmapped "off".
		default:
			levelMap[level] = value
		}
	}
	model["reasoning"] = true
	model["thinkingLevelMap"] = levelMap
	compat, _ := model["compat"].(map[string]any)
	if compat == nil {
		compat = map[string]any{}
	}
	switch api {
	case apiAnthropic:
		if effort.Adaptive {
			compat["forceAdaptiveThinking"] = true
		}
	case apiChat:
		// OpenAI-compatible relays take the level as reasoning_effort.
		if compat["thinkingFormat"] == nil {
			compat["supportsReasoningEffort"] = true
		}
	}
	if len(compat) > 0 {
		model["compat"] = compat
	} else {
		delete(model, "compat")
	}
	return true
}

// upgradeOfficialEfforts gives configured models with a known official ID the
// official levels when the configuration has none, so models added before this
// catalog existed show and send the right effort. Models with a level map or
// explicit reasoning stay as configured.
func upgradeOfficialEfforts(providers map[string]any) bool {
	changed := false
	for _, raw := range providers {
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		providerAPI, _ := p["api"].(string)
		for _, m := range configuredModels(p) {
			if m["reasoning"] == true || m["thinkingLevelMap"] != nil {
				continue
			}
			id, _ := m["id"].(string)
			api, _ := m["api"].(string)
			if api == "" {
				api = providerAPI
			}
			if applyOfficialEffort(m, id, api) {
				changed = true
			}
		}
	}
	return changed
}

// officialDefaultLevel is the effort a model's own API uses when a request
// names none: high for adaptive Claude models, medium elsewhere, moved to the
// nearest level the model supports.
func officialDefaultLevel(id string) string {
	effort, ok := officialEffortForID(id)
	if !ok || len(effort.Levels) == 0 {
		return ""
	}
	want := "medium"
	if effort.Adaptive {
		want = "high"
	}
	start := 0
	for i, level := range piThinkingLevels {
		if level == want {
			start = i
		}
	}
	for i := start; i < len(piThinkingLevels); i++ {
		if _, ok := effort.Levels[piThinkingLevels[i]]; ok {
			return piThinkingLevels[i]
		}
	}
	for i := start - 1; i >= 0; i-- {
		if _, ok := effort.Levels[piThinkingLevels[i]]; ok {
			return piThinkingLevels[i]
		}
	}
	return ""
}

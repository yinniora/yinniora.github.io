package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// rememberModelChoice stores the model and effort last chosen in a session as
// Pi's defaults, so new sessions and later model switches start from them.
// Pi reads defaultProvider/defaultModel for new sessions and
// modelThinkingLevels for the effort of each model. Other settings are kept.
func rememberModelChoice(agent, provider, modelID, level string) error {
	if provider == "" || modelID == "" {
		return nil
	}
	path := filepath.Join(agent, "settings.json")
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) || err == nil && (!info.Mode().IsRegular() || info.Size() > 4<<20) {
		return errors.New("cannot read local Pi settings")
	}
	settings := map[string]json.RawMessage{}
	var previous []byte
	if err == nil {
		previous, err = os.ReadFile(path)
		if err != nil || json.Unmarshal(previous, &settings) != nil || settings == nil {
			return errors.New("cannot read local Pi settings")
		}
	}
	set := func(key string, value any) {
		raw, _ := json.Marshal(value)
		settings[key] = raw
	}
	set("defaultProvider", provider)
	set("defaultModel", modelID)
	if level != "" {
		levels := map[string]string{}
		if value := settings["modelThinkingLevels"]; len(value) != 0 && json.Unmarshal(value, &levels) != nil {
			return errors.New("cannot read per-model thinking defaults")
		}
		if levels == nil {
			levels = map[string]string{}
		}
		levels[provider+"/"+modelID] = level
		set("modelThinkingLevels", levels)
		set("defaultThinkingLevel", level)
	}
	next, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	if bytes.Equal(next, previous) {
		return nil
	}
	return writePrivateModelFile(path, next)
}

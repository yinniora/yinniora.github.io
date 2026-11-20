package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRememberModelChoiceKeepsOtherSettings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"compaction":{"reserveTokens":36096},"modelThinkingLevels":{"other/m":"low"},"defaultModel":"old"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := rememberModelChoice(dir, "relay", "claude-opus-5-5", "xhigh"); err != nil {
		t.Fatal(err)
	}
	if err := rememberModelChoice(dir, "relay", "gpt-5.5", ""); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var settings struct {
		DefaultProvider, DefaultModel, DefaultThinkingLevel string
		ModelThinkingLevels                                 map[string]string
		Compaction                                          map[string]any
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.DefaultProvider != "relay" || settings.DefaultModel != "gpt-5.5" || settings.DefaultThinkingLevel != "xhigh" ||
		settings.ModelThinkingLevels["relay/claude-opus-5-5"] != "xhigh" || settings.ModelThinkingLevels["other/m"] != "low" ||
		settings.Compaction["reserveTokens"] != float64(36096) {
		t.Fatalf("unexpected settings: %s", raw)
	}
}

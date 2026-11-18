package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pluginTestRequest(s *Server, method, remote, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://localhost/api/plugins", strings.NewReader(body))
	request.RemoteAddr = remote
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.handlePlugins(response, request)
	return response
}

func TestPluginSettingsLocalRegistrationAndIsolation(t *testing.T) {
	s := &Server{agentDir: t.TempDir()}
	existing := []byte(`{"mcpServers":{"private":{"url":"https://example.invalid/","headers":{"Authorization":"fixture-hidden-secret"}}},"autoEnableCodemode":false}`)
	if err := os.WriteFile(filepath.Join(s.agentDir, "mcp.json"), existing, 0600); err != nil {
		t.Fatal(err)
	}
	get := func() pluginSettings {
		t.Helper()
		response := pluginTestRequest(s, "GET", "127.0.0.1:1234", "")
		var out pluginSettings
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &out) != nil || strings.Contains(response.Body.String(), "fixture-hidden-secret") {
			t.Fatal("invalid or unsanitized list", response.Code)
		}
		return out
	}
	action := func(req pluginAction, code int) {
		t.Helper()
		response := pluginTestRequest(s, "POST", "127.0.0.1:1234", string(pluginJSON(req)))
		if response.Code != code {
			t.Fatal("unexpected plugin response", response.Code, response.Body.String())
		}
	}
	before := get()
	remote := pluginTestRequest(s, "GET", "approved-device:0", "")
	if remote.Code != 200 || strings.Contains(remote.Body.String(), "private") || strings.Contains(remote.Body.String(), before.Revision) {
		t.Fatal("private list reached a remote client")
	}
	request := pluginAction{Action: "add-mcp", Revision: before.Revision, Name: "fixture", Kind: "http", URL: "https://example.invalid/mcp"}
	if response := pluginTestRequest(s, "POST", "approved-device:0", string(pluginJSON(request))); response.Code != 403 {
		t.Fatal("remote configuration was allowed")
	}
	action(request, 200)
	action(request, 409)
	data, err := readPluginFile(s.agentDir, "mcp.json")
	if err != nil || string(data["autoEnableCodemode"]) != "false" || !strings.Contains(string(data["mcpServers"]), "fixture-hidden-secret") {
		t.Fatal("existing configuration was changed", err)
	}
	after := get()
	action(pluginAction{Action: "toggle-mcp", Revision: after.Revision, Name: "fixture", Enabled: false}, 200)
	action(pluginAction{Action: "remove-mcp", Revision: get().Revision, Name: "fixture"}, 200)
	skill := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.WriteFile(skill, []byte("---\nname: sample\ndescription: Test fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	action(pluginAction{Action: "add-skill", Revision: get().Revision, Source: filepath.Dir(skill)}, 200)
	if skills := get().Skills; len(skills) != 1 || skills[0] != skill {
		t.Fatal("the new skill was not registered")
	}
	action(pluginAction{Action: "remove-skill", Revision: get().Revision, Source: skill}, 200)
	if _, err := os.Stat(skill); err != nil {
		t.Fatal("removing the reference deleted skill files", err)
	}
}

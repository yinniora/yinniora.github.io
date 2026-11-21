package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"pi-web/internal/picmd"
)

var npmPiSource = regexp.MustCompile(`^npm:(@[A-Za-z0-9._-]+/)?[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._+-]*)?$`)
var mcpServerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func readPluginFile(dir, name string) (map[string]json.RawMessage, error) {
	file := filepath.Join(dir, name)
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, errors.New("invalid plugin configuration file")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		return nil, errors.New("invalid plugin configuration JSON")
	}
	return result, nil
}

func writePluginFile(dir, name string, data map[string]json.RawMessage) error {
	buf, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".pi-plugin-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(append(buf, '\n'))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return os.Rename(f.Name(), filepath.Join(dir, name))
}

func pluginJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

type pluginPackage struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Removable bool   `json:"removable"`
}
type pluginMCP struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Enabled bool   `json:"enabled"`
}
type pluginSettings struct {
	Local      bool            `json:"local"`
	Packages   []pluginPackage `json:"packages"`
	Skills     []string        `json:"skills"`
	Servers    []pluginMCP     `json:"servers"`
	MCPEnabled bool            `json:"mcpEnabled"`
	Revision   string          `json:"revision"`
}

func normalizePiSource(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 512 || strings.ContainsAny(value, "\r\n\x00") {
		return ""
	}
	if npmPiSource.MatchString(value) {
		return value
	}
	if strings.HasPrefix(value, "git:https://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "git:github.com/") {
		raw := strings.TrimPrefix(value, "git:")
		if strings.HasPrefix(raw, "github.com/") {
			raw = "https://" + raw
		}
		u, err := url.Parse(raw)
		if err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && len(strings.Trim(u.Path, "/")) > 0 {
			return "git:" + raw
		}
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return ""
}

func piPackageSources(dir string, settings map[string]json.RawMessage) (map[string]string, []pluginPackage, error) {
	sources := map[string]string{}
	packages := []pluginPackage{}
	var list []json.RawMessage
	if raw := settings["packages"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, nil, err
		}
	}
	for _, raw := range list {
		var source string
		if json.Unmarshal(raw, &source) != nil {
			var item struct {
				Source string `json:"source"`
			}
			if json.Unmarshal(raw, &item) != nil {
				continue
			}
			source = item.Source
		}
		if strings.TrimSpace(source) == "" {
			continue
		}
		sum := sha256.Sum256([]byte(source))
		id := hex.EncodeToString(sum[:16])
		if _, exists := sources[id]; exists {
			continue
		}
		normalized := normalizePiSource(source)
		if normalized == "" && (strings.HasPrefix(source, "./") || strings.HasPrefix(source, "../")) {
			normalized = normalizePiSource(filepath.Join(dir, filepath.FromSlash(source)))
		}
		sources[id] = normalized
		label := "Configured Pi package"
		if normalized != "" {
			label = normalized
		}
		packages = append(packages, pluginPackage{ID: id, Label: label, Removable: normalized != ""})
	}
	return sources, packages, nil
}

func pluginData(dir string, settings, mcp map[string]json.RawMessage) (pluginSettings, map[string]string, map[string]map[string]json.RawMessage, error) {
	sources, packages, err := piPackageSources(dir, settings)
	if err != nil {
		return pluginSettings{}, nil, nil, err
	}
	out := pluginSettings{Local: true, Packages: packages, Skills: []string{}, Servers: []pluginMCP{}, MCPEnabled: true}
	var extensions []string
	if value := settings["extensions"]; len(value) > 0 && json.Unmarshal(value, &extensions) != nil {
		return pluginSettings{}, nil, nil, errors.New("invalid Pi extension settings")
	}
	for _, value := range extensions {
		if value == "-builtin:mcp" {
			out.MCPEnabled = false
		}
	}
	if value := settings["skills"]; len(value) > 0 && json.Unmarshal(value, &out.Skills) != nil {
		return pluginSettings{}, nil, nil, errors.New("invalid Pi skills settings")
	}
	var servers map[string]map[string]json.RawMessage
	if value := mcp["mcpServers"]; len(value) > 0 && json.Unmarshal(value, &servers) != nil {
		return pluginSettings{}, nil, nil, errors.New("invalid MCP server settings")
	}
	if servers == nil {
		servers = map[string]map[string]json.RawMessage{}
	}
	for name, server := range servers {
		if server == nil {
			continue
		}
		var endpoint string
		_ = json.Unmarshal(server["url"], &endpoint)
		kind := "stdio"
		if endpoint != "" {
			kind = "http"
		}
		enabled := true
		_ = json.Unmarshal(server["enabled"], &enabled)
		out.Servers = append(out.Servers, pluginMCP{Name: name, Kind: kind, Enabled: enabled})
	}
	sort.Slice(out.Servers, func(i, j int) bool { return out.Servers[i].Name < out.Servers[j].Name })
	version := sha256.Sum256(pluginJSON([]map[string]json.RawMessage{settings, mcp}))
	out.Revision = hex.EncodeToString(version[:])
	return out, sources, servers, nil
}

func (s *Server) runPiPackage(ctx context.Context, action, source string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := picmd.Command(ctx, action, source, "--no-approve")
	cmd.Dir = s.agentDir
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "PI_CODING_AGENT_DIR" || strings.HasPrefix(key, "PI_WEB_") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "PI_CODING_AGENT_DIR="+s.agentDir)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run()
}

type pluginAction struct {
	Action   string   `json:"action"`
	Revision string   `json:"revision"`
	Source   string   `json:"source"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	URL      string   `json:"url"`
	Command  string   `json:"command"`
	Args     []string `json:"args"`
	Enabled  bool     `json:"enabled"`
}

func newMCPServer(body pluginAction) (map[string]json.RawMessage, error) {
	cfg := map[string]json.RawMessage{"enabled": pluginJSON(true), "exposure": pluginJSON("deferred")}
	switch body.Kind {
	case "http":
		u, err := url.Parse(strings.TrimSpace(body.URL))
		if err != nil || len(body.URL) > 2048 || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
			return nil, errors.New("invalid-endpoint")
		}
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))) {
			return nil, errors.New("invalid-endpoint")
		}
		cfg["url"] = pluginJSON(u.String())
	case "stdio":
		cmd := strings.TrimSpace(body.Command)
		if cmd == "" || len(cmd) > 512 || strings.HasPrefix(cmd, "-") || strings.ContainsAny(cmd, "\x00\r\n") || len(body.Args) > 64 {
			return nil, errors.New("invalid-command")
		}
		for _, arg := range body.Args {
			if len(arg) > 4096 || strings.ContainsRune(arg, 0) {
				return nil, errors.New("invalid-command")
			}
		}
		if body.Args == nil {
			body.Args = []string{}
		}
		cfg["command"] = pluginJSON(cmd)
		cfg["args"] = pluginJSON(body.Args)
	default:
		return nil, errors.New("invalid-transport")
	}
	return cfg, nil
}

func skillFile(source string) string {
	source = strings.TrimSpace(source)
	if strings.HasPrefix(source, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		source = filepath.Join(home, source[2:])
	}
	if !filepath.IsAbs(source) || len(source) > 4096 || strings.ContainsAny(source, "\x00\r\n") {
		return ""
	}
	source = filepath.Clean(source)
	if info, err := os.Stat(source); err == nil && info.IsDir() {
		source = filepath.Join(source, "SKILL.md")
	}
	info, err := os.Stat(source)
	if filepath.Base(source) != "SKILL.md" || err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return ""
	}
	return source
}

func (s *Server) handlePlugins(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !localDeviceAdmin(r) {
		if r.Method == http.MethodGet {
			writeJSON(w, 200, pluginSettings{Local: false})
			return
		}
		writeJSONError(w, 403, "local-only")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSONError(w, 405, "method-not-allowed")
		return
	}
	if r.Method == http.MethodPost {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
			writeJSONError(w, 403, "local-only")
			return
		}
		if r.Header.Get("Content-Type") == "" {
			writeJSONError(w, 415, "invalid-config")
			return
		}
	}
	var body pluginAction
	if r.Method == http.MethodPost && !decodeJSONBody(w, r, &body) {
		return
	}
	if !s.pluginConfigMu.TryLock() {
		writeJSONError(w, 409, "busy")
		return
	}
	defer s.pluginConfigMu.Unlock()
	settings, err := readPluginFile(s.agentDir, "settings.json")
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	mcp, err := readPluginFile(s.agentDir, "mcp.json")
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	data, sources, servers, err := pluginData(s.agentDir, settings, mcp)
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 200, data)
		return
	}
	if body.Revision != data.Revision {
		writeJSONError(w, 409, "changed")
		return
	}
	switch body.Action {
	case "install-package", "remove-package":
		action := "install"
		source := normalizePiSource(body.Source)
		if body.Action == "remove-package" {
			action = "remove"
			source = sources[body.Source]
		}
		if source == "" || normalizePiSource(source) == "" {
			writeJSONError(w, 400, "invalid-source")
			return
		}
		err = s.runPiPackage(r.Context(), action, source)
	case "add-skill", "remove-skill":
		skills := data.Skills
		if body.Action == "add-skill" {
			p := skillFile(body.Source)
			if p == "" {
				writeJSONError(w, 400, "invalid-skill")
				return
			}
			for _, skill := range skills {
				if skill == p {
					writeJSON(w, 200, data)
					return
				}
			}
			skills = append(skills, p)
		} else {
			next := []string{}
			for _, skill := range skills {
				if skill != body.Source {
					next = append(next, skill)
				}
			}
			skills = next
		}
		settings["skills"] = pluginJSON(skills)
		err = writePluginFile(s.agentDir, "settings.json", settings)
	case "add-mcp", "remove-mcp", "toggle-mcp":
		if body.Action == "add-mcp" {
			if !mcpServerName.MatchString(body.Name) {
				writeJSONError(w, 400, "invalid-name")
				return
			}
			if _, exists := servers[body.Name]; exists {
				writeJSONError(w, 409, "duplicate-name")
				return
			}
			cfg, cfgErr := newMCPServer(body)
			if cfgErr != nil {
				writeJSONError(w, 400, cfgErr.Error())
				return
			}
			servers[body.Name] = cfg
		} else if cfg, ok := servers[body.Name]; !ok || cfg == nil {
			writeJSONError(w, 404, "missing-server")
			return
		} else if body.Action == "toggle-mcp" {
			cfg["enabled"] = pluginJSON(body.Enabled)
		} else {
			delete(servers, body.Name)
		}
		mcp["mcpServers"] = pluginJSON(servers)
		err = writePluginFile(s.agentDir, "mcp.json", mcp)
	default:
		writeJSONError(w, 400, "invalid-action")
		return
	}
	if err != nil {
		writeJSONError(w, 500, "operation-failed")
		return
	}
	if manager, ok := s.chatSender.(interface{ ResourcesChanged() }); ok {
		manager.ResourcesChanged()
	}
	settings, err = readPluginFile(s.agentDir, "settings.json")
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	mcp, err = readPluginFile(s.agentDir, "mcp.json")
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	data, _, _, err = pluginData(s.agentDir, settings, mcp)
	if err != nil {
		writeJSONError(w, 500, "invalid-config")
		return
	}
	writeJSON(w, 200, data)
}

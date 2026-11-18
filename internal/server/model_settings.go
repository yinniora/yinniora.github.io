package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type modelCatalog struct {
	Signature string
	Models    []map[string]any
}
type modelProfile struct {
	ID        string           `json:"id"`
	Label     string           `json:"label"`
	BaseURL   string           `json:"baseUrl"`
	API       string           `json:"api"`
	HasKey    bool             `json:"hasKey"`
	Applied   []map[string]any `json:"applied"`
	Available []map[string]any `json:"available"`
}
type modelSettingsRequest struct {
	Action        string   `json:"action"`
	Revision      string   `json:"revision"`
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	BaseURL       string   `json:"baseUrl"`
	API           string   `json:"api"`
	Key           string   `json:"key"`
	ModelIDs      []string `json:"modelIds"`
	ModelID       string   `json:"modelId"`
	Vision        bool     `json:"vision"`
	Reasoning     bool     `json:"reasoning"`
	ContextWindow int      `json:"contextWindow"`
	MaxTokens     int      `json:"maxTokens"`
}

func readModelConfig(agent string) (map[string]any, map[string]any, string, error) {
	file := filepath.Join(agent, "models.json")
	if st, err := os.Lstat(file); err == nil && (!st.Mode().IsRegular() || st.Size() > 4<<20) {
		return nil, nil, "", errors.New("models configuration must be a regular file under 4 MiB")
	}
	raw, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		raw = []byte(`{"providers":{}}`)
		err = nil
	}
	if err != nil {
		return nil, nil, "", errors.New("cannot read models configuration")
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil || config == nil {
		return nil, nil, "", errors.New("models configuration is invalid; existing settings were left intact")
	}
	providers, ok := config["providers"].(map[string]any)
	if !ok {
		if config["providers"] != nil {
			return nil, nil, "", errors.New("invalid providers configuration")
		}
		providers = map[string]any{}
		config["providers"] = providers
	}
	hash := sha256.Sum256(raw)
	return config, providers, hex.EncodeToString(hash[:]), nil
}

func literalModelKey(key string) string {
	value := strings.ReplaceAll(key, "$", "$$")
	if strings.HasPrefix(value, "!") {
		value = "$" + value
	}
	return value
}

// Never execute credential commands when refreshing a user-selected source.
func (s *Server) modelProfileKey(id string, p map[string]any) string {
	var auth map[string]map[string]any
	if raw, err := os.ReadFile(filepath.Join(s.agentDir, "auth.json")); err == nil && json.Unmarshal(raw, &auth) == nil {
		if entry := auth[id]; entry["type"] == "api_key" {
			if key, ok := entry["key"].(string); ok {
				return key
			}
		}
	}
	value, _ := p["apiKey"].(string)
	if strings.HasPrefix(value, "!") {
		return ""
	}
	if strings.HasPrefix(value, "$!") {
		value = value[1:]
	}
	// Only support a single environment reference, or our escaped literal.
	if strings.HasPrefix(value, "$") && !strings.HasPrefix(value, "$$") {
		name := strings.TrimPrefix(value, "$")
		name = strings.TrimSuffix(strings.TrimPrefix(name, "{"), "}")
		return os.Getenv(name)
	}
	return strings.ReplaceAll(value, "$$", "$")
}

func profileSignature(p map[string]any, key string) string {
	raw, _ := json.Marshal([]any{p["baseUrl"], p["api"], key})
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func configuredModels(p map[string]any) []map[string]any {
	list := []map[string]any{}
	if raw, ok := p["models"].([]any); ok {
		for _, v := range raw {
			if m, ok := v.(map[string]any); ok {
				list = append(list, m)
			}
		}
	}
	return list
}

func publicModel(m map[string]any, provider, label string) map[string]any {
	result := map[string]any{"provider": provider, "providerLabel": label, "id": m["id"], "name": m["id"], "input": []string{"text"}, "reasoning": false, "contextWindow": 128000, "maxTokens": 8192}
	for _, key := range []string{"name", "input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap", "cost", "api", "supportsTools"} {
		if value, ok := m[key]; ok {
			result[key] = value
		}
	}
	if id, ok := m["id"].(string); ok && fixedThinkingAlias.MatchString(id) {
		result["reasoning"] = false
	}
	return result
}

func (s *Server) modelProfiles(providers map[string]any) []modelProfile {
	profiles := []modelProfile{}
	for id, raw := range providers {
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		base, _ := p["baseUrl"].(string)
		api, _ := p["api"].(string)
		if base == "" || api == "" {
			continue
		}
		label, _ := p["name"].(string)
		if label == "" {
			label = id
		}
		key := s.modelProfileKey(id, p)
		publicBase := base
		if u, e := url.Parse(base); e == nil {
			u.User = nil
			u.RawQuery = ""
			u.Fragment = ""
			publicBase = u.String()
		}
		row := modelProfile{ID: id, Label: label, BaseURL: publicBase, API: api, HasKey: key != "", Applied: []map[string]any{}, Available: []map[string]any{}}
		for _, m := range configuredModels(p) {
			visible := publicModel(m, id, label)
			if key != "" && modelEffortCheckable(p, m) {
				visible["canVerifyEffort"] = true
			}
			row.Applied = append(row.Applied, visible)
		}
		row.Available = append(row.Available, row.Applied...)
		if catalog, ok := s.modelCatalogs[id]; ok && catalog.Signature == profileSignature(p, key) {
			row.Available = []map[string]any{}
			toolsByID := map[string]bool{}
			for _, m := range catalog.Models {
				row.Available = append(row.Available, publicModel(m, id, label))
				toolsByID[m["id"].(string)] = m["supportsTools"] == true
			}
			for _, m := range row.Applied {
				if modelID, ok := m["id"].(string); ok && toolsByID[modelID] {
					m["supportsTools"] = true
				}
			}
		}
		profiles = append(profiles, row)
	}
	sort.Slice(profiles, func(i, j int) bool { return profiles[i].Label < profiles[j].Label })
	return profiles
}

func modelBaseURL(raw, api string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid endpoint")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, errors.New("HTTPS is required except for a local model server")
	}
	switch api {
	case "openai-completions", "openai-responses", "anthropic-messages":
		if u.Path == "" {
			u.Path = "/v1"
		}
	case "google-generative-ai":
		if u.Path == "" {
			u.Path = "/v1beta"
		}
	default:
		return nil, errors.New("unsupported model API")
	}
	return u, nil
}

func (s *Server) discoverModels(ctx context.Context, p map[string]any, key string) ([]map[string]any, error) {
	api, _ := p["api"].(string)
	modelAPI, _ := p["catalogFallbackAPI"].(string)
	if modelAPI == "" {
		modelAPI = api
	}
	base, _ := p["baseUrl"].(string)
	u, err := modelBaseURL(base, api)
	if err != nil {
		return nil, err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/models"
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	models := []map[string]any{}
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 10; page++ {
		q := u.Query()
		if api == "anthropic-messages" {
			q.Set("limit", "1000")
			if cursor != "" {
				q.Set("after_id", cursor)
			}
		}
		if api == "google-generative-ai" {
			q.Set("pageSize", "1000")
			if cursor != "" {
				q.Set("pageToken", cursor)
			}
		}
		u.RawQuery = q.Encode()
		req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		req.Header.Set("Accept", "application/json")
		switch api {
		case "anthropic-messages":
			req.Header.Set("x-api-key", key)
			req.Header.Set("anthropic-version", "2023-06-01")
		case "google-generative-ai":
			req.Header.Set("x-goog-api-key", key)
		default:
			req.Header.Set("Authorization", "Bearer "+key)
		}
		response, err := client.Do(req)
		if err != nil {
			return nil, errors.New("cannot connect to the model service")
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
		response.Body.Close()
		if response.StatusCode != 200 {
			return nil, fmt.Errorf("model service returned HTTP %d", response.StatusCode)
		}
		if readErr != nil || len(body) > 4<<20 {
			return nil, errors.New("model service response is too large")
		}
		var doc struct {
			Data          []map[string]any `json:"data"`
			Models        []map[string]any `json:"models"`
			HasMore       bool             `json:"has_more"`
			LastID        string           `json:"last_id"`
			NextPageToken string           `json:"nextPageToken"`
		}
		if json.Unmarshal(body, &doc) != nil || (doc.Data == nil && doc.Models == nil) {
			return nil, errors.New("model service did not return a supported model list")
		}
		batch := doc.Data
		if doc.Models != nil {
			batch = doc.Models
		}
		for _, raw := range batch {
			id, _ := raw["id"].(string)
			if id == "" {
				id, _ = raw["name"].(string)
				id = strings.TrimPrefix(id, "models/")
			}
			if id == "" || len(id) > 512 || strings.ContainsAny(id, "\r\n\x00") || (key != "" && strings.Contains(id, key)) || seen[id] {
				continue
			}
			seen[id] = true
			m := map[string]any{"id": id, "name": id}
			describeCatalogModel(m, raw, id, modelAPI, base)
			for _, field := range []string{"display_name", "displayName"} {
				if name, ok := raw[field].(string); ok && len(name) <= 512 && !strings.Contains(name, key) {
					m["name"] = name
				}
			}
			if api == "google-generative-ai" {
				if n, ok := raw["inputTokenLimit"].(float64); ok {
					m["contextWindow"] = n
				}
				if n, ok := raw["outputTokenLimit"].(float64); ok {
					m["maxTokens"] = n
				}
				if methods, ok := raw["supportedGenerationMethods"].([]any); ok {
					chat := false
					for _, v := range methods {
						chat = chat || v == "generateContent"
					}
					if !chat {
						continue
					}
				}
			}
			models = append(models, m)
			if len(models) > 10000 {
				return nil, errors.New("too many models")
			}
		}
		next := doc.NextPageToken
		if doc.HasMore {
			next = doc.LastID
		}
		if next == "" {
			sort.Slice(models, func(i, j int) bool { return models[i]["id"].(string) < models[j]["id"].(string) })
			return models, nil
		}
		if next == cursor {
			return nil, errors.New("model pagination did not advance")
		}
		cursor = next
	}
	return nil, errors.New("model list exceeded pagination limit")
}

func writeModelConfig(agent string, config map[string]any) error {
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return writePrivateModelFile(filepath.Join(agent, "models.json"), append(raw, '\n'))
}

func writePrivateModelFile(path string, raw []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".yugo-models-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func deleteModelKey(agent, id string, config map[string]any) error {
	authPath := filepath.Join(agent, "auth.json")
	info, err := os.Lstat(authPath)
	if errors.Is(err, os.ErrNotExist) {
		return writeModelConfig(agent, config)
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return errors.New("cannot read private model credentials")
	}
	previous, err := os.ReadFile(authPath)
	var auth map[string]json.RawMessage
	if err != nil || json.Unmarshal(previous, &auth) != nil {
		return errors.New("cannot read private model credentials")
	}
	var credential struct{ Type string }
	if raw := auth[id]; len(raw) == 0 || json.Unmarshal(raw, &credential) != nil || credential.Type != "api_key" {
		return writeModelConfig(agent, config)
	}
	delete(auth, id)
	next, err := json.MarshalIndent(auth, "", "  ")
	if err != nil {
		return errors.New("cannot encode private model credentials")
	}
	next = append(next, '\n')
	if current, err := os.ReadFile(authPath); err != nil || !bytes.Equal(current, previous) {
		return errModelCredentialsChanged
	}
	if err := writePrivateModelFile(authPath, next); err != nil {
		return errors.New("cannot save private model credentials")
	}
	if err := writeModelConfig(agent, config); err != nil {
		// Revert our auth write only if another writer hasn't updated the file.
		if current, readErr := os.ReadFile(authPath); readErr == nil && bytes.Equal(current, next) {
			if restoreErr := writePrivateModelFile(authPath, previous); restoreErr != nil {
				return errors.New("model configuration could not be saved and credentials could not be restored")
			}
		}
		return err
	}
	return nil
}

var errModelCredentialsChanged = errors.New("model credentials changed; reload and try again")

// Canonical custom models take precedence over a stale Pi enumeration cache.
// Only public metadata is sent to browsers; provider headers and keys stay local.
func (s *Server) appliedModels(fallback []map[string]any) ([]map[string]any, error) {
	s.modelConfigMu.Lock()
	defer s.modelConfigMu.Unlock()
	_, providers, _, err := readModelConfig(s.agentDir)
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	availableProviders := map[string]bool{}
	for _, m := range fallback {
		id, _ := m["provider"].(string)
		if _, removed := s.removedModelProviders[id]; removed && providers[id] == nil {
			continue
		}
		availableProviders[id] = true
		if p, ok := providers[id].(map[string]any); ok && p["models"] != nil {
			continue
		}
		result = append(result, publicModel(m, id, id))
	}
	for _, p := range s.modelProfiles(providers) {
		if p.HasKey || availableProviders[p.ID] {
			result = append(result, p.Applied...)
		}
	}
	return result, nil
}

func (s *Server) handleModelSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var request modelSettingsRequest
	if r.Method == http.MethodPost && !decodeJSONBody(w, r, &request) {
		return
	}
	s.modelConfigMu.Lock()
	defer s.modelConfigMu.Unlock()
	config, providers, revision, err := readModelConfig(s.agentDir)
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"profiles": s.modelProfiles(providers), "revision": revision})
		return
	}
	if request.Revision != revision {
		writeJSONError(w, 409, "model configuration changed; reload and try again")
		return
	}
	p, _ := providers[request.ID].(map[string]any)
	switch request.Action {
	case "add":
		request.Label = strings.TrimSpace(request.Label)
		request.Key = strings.TrimSpace(request.Key)
		if request.Label == "" || len(request.Label) > 100 || request.Key == "" || len(request.Key) > 8192 || strings.ContainsAny(request.Key, "\r\n\x00") {
			writeJSONError(w, 400, "a label and valid API key are required")
			return
		}
		var random [12]byte
		if _, e := rand.Read(random[:]); e != nil {
			writeJSONError(w, 500, "cannot create profile")
			return
		}
		id := "yugo-" + hex.EncodeToString(random[:])
		var models []map[string]any
		var u *url.URL
		var e error
		if request.API == "" || request.API == "auto" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			s.modelConfigMu.Unlock()
			u, request.API, models, e = s.detectModelProtocol(ctx, strings.TrimSpace(request.BaseURL), request.Key)
			cancel()
			s.modelConfigMu.Lock()
		} else {
			u, e = modelBaseURL(request.BaseURL, request.API)
		}
		if e != nil {
			writeJSONError(w, 400, e.Error())
			return
		}
		profile := map[string]any{"name": request.Label, "baseUrl": u.String(), "api": request.API, "apiKey": literalModelKey(request.Key), "models": []any{}}
		providers[id] = profile
		if models != nil {
			if s.modelCatalogs == nil {
				s.modelCatalogs = make(map[string]modelCatalog)
			}
			s.modelCatalogs[id] = modelCatalog{Signature: profileSignature(profile, request.Key), Models: models}
		}
	case "refresh":
		if p == nil {
			writeJSONError(w, 404, "key profile not found")
			return
		}
		key := s.modelProfileKey(request.ID, p)
		if key == "" {
			writeJSONError(w, 400, "this profile has no directly available API key")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		signature := profileSignature(p, key)
		s.modelConfigMu.Unlock()
		var models []map[string]any
		if p["api"] == apiAnthropic {
			// Some dual-protocol services only attach capability metadata to
			// their Bearer catalog. Keep the saved execution API as fallback.
			models, _ = s.discoverModels(ctx, map[string]any{"api": apiChat, "baseUrl": p["baseUrl"], "catalogFallbackAPI": apiAnthropic}, key)
		}
		var e error
		if models == nil {
			models, e = s.discoverModels(ctx, p, key)
		}
		s.modelConfigMu.Lock()
		if e != nil {
			writeJSONError(w, 400, e.Error())
			return
		}
		config, providers, revision, e = readModelConfig(s.agentDir)
		current, _ := providers[request.ID].(map[string]any)
		if e != nil || current == nil || profileSignature(current, s.modelProfileKey(request.ID, current)) != signature {
			writeJSONError(w, 409, "model configuration changed; refresh again")
			return
		}
		if s.modelCatalogs == nil {
			s.modelCatalogs = map[string]modelCatalog{}
		}
		s.modelCatalogs[request.ID] = modelCatalog{Signature: signature, Models: models}
		detected := map[string]map[string]any{}
		for _, m := range models {
			detected[m["id"].(string)] = m
		}
		changed := false
		for _, m := range configuredModels(current) {
			id, _ := m["id"].(string)
			detection := detected[id]
			// Refresh can enable confirmed capability on existing model records
			// when the request protocol stays the same.
			actual, _ := m["api"].(string)
			if actual == "" {
				actual, _ = current["api"].(string)
			}
			if detection["reasoning"] != true || detection["api"] != actual || m["reasoning"] == true {
				continue
			}
			m["reasoning"] = true
			for _, field := range []string{"compat", "thinkingLevelMap"} {
				if m[field] == nil && detection[field] != nil {
					m[field] = detection[field]
				}
			}
			changed = true
		}
		if changed {
			if e := writeModelConfig(s.agentDir, config); e != nil {
				writeJSONError(w, 500, "could not update model capabilities")
				return
			}
			if manager, ok := s.chatSender.(interface{ ModelsChanged() }); ok {
				manager.ModelsChanged()
			}
			_, _, revision, _ = readModelConfig(s.agentDir)
		}
		writeJSON(w, 200, map[string]any{"profiles": s.modelProfiles(providers), "revision": revision})
		return
	case "apply":
		if p == nil {
			writeJSONError(w, 404, "key profile not found")
			return
		}
		if len(request.ModelIDs) == 0 || len(request.ModelIDs) > 1000 {
			writeJSONError(w, 400, "select between 1 and 1000 models")
			return
		}
		if request.ContextWindow < 0 || request.ContextWindow > 10000000 || request.MaxTokens < 0 || request.MaxTokens > 1000000 {
			writeJSONError(w, 400, "invalid model limits")
			return
		}
		existing := configuredModels(p)
		allowed := map[string]map[string]any{}
		present := map[string]bool{}
		for _, m := range existing {
			if id, ok := m["id"].(string); ok {
				allowed[id] = m
				present[id] = true
			}
		}
		if c, ok := s.modelCatalogs[request.ID]; ok && c.Signature == profileSignature(p, s.modelProfileKey(request.ID, p)) {
			for _, m := range c.Models {
				allowed[m["id"].(string)] = m
			}
		}
		for _, id := range request.ModelIDs {
			m, ok := allowed[id]
			if !ok {
				writeJSONError(w, 400, "refresh this key and select an available model")
				return
			}
			if present[id] {
				continue
			}
			next := map[string]any{}
			for k, v := range m {
				next[k] = v
			}
			delete(next, "supportsTools")
			if next["input"] == nil {
				next["input"] = []string{"text"}
			}
			if request.Vision {
				next["input"] = []string{"text", "image"}
			}
			if next["reasoning"] != true {
				next["reasoning"] = request.Reasoning && !fixedThinkingAlias.MatchString(id)
			}
			if request.ContextWindow > 0 {
				next["contextWindow"] = request.ContextWindow
			}
			if request.MaxTokens > 0 {
				next["maxTokens"] = request.MaxTokens
			}
			existing = append(existing, next)
			present[id] = true
		}
		p["models"] = existing
	case "verify-effort":
		check := [2]string{request.ID, request.ModelID}
		if _, running := s.modelEffortChecks[check]; running {
			writeJSONError(w, 409, "an effort check is already running")
			return
		}
		var model map[string]any
		for _, candidate := range configuredModels(p) {
			if candidate["id"] == request.ModelID {
				model = candidate
				break
			}
		}
		if model == nil || !modelEffortCheckable(p, model) {
			writeJSONError(w, 400, "the selected model cannot be checked")
			return
		}
		if s.modelEffortChecks == nil {
			s.modelEffortChecks = map[[2]string]struct{}{}
		}
		s.modelEffortChecks[check] = struct{}{}
		key := s.modelProfileKey(request.ID, p)
		ctx, cancel := context.WithTimeout(r.Context(), 22*time.Second)
		s.modelConfigMu.Unlock()
		levels, compat, verifyErr := verifyModelEffort(ctx, p, model, key)
		cancel()
		s.modelConfigMu.Lock()
		delete(s.modelEffortChecks, check)
		if verifyErr != nil {
			writeJSONError(w, 422, verifyErr.Error())
			return
		}
		if s.modelProfileKey(request.ID, p) != key {
			writeJSONError(w, 409, "model credentials changed; reload and try again")
			return
		}
		model["reasoning"] = true
		model["thinkingLevelMap"] = levels
		if len(compat) > 0 {
			model["compat"] = compat
		}
	case "remove-model":
		if p == nil || request.ModelID == "" {
			writeJSONError(w, 404, "model not found")
			return
		}
		list := []map[string]any{}
		for _, m := range configuredModels(p) {
			if m["id"] != request.ModelID {
				list = append(list, m)
			}
		}
		p["models"] = list
	case "remove-key":
		base, _ := p["baseUrl"].(string)
		api, _ := p["api"].(string)
		if base == "" || api == "" {
			writeJSONError(w, 404, "key profile not found")
			return
		}
		delete(providers, request.ID)
	default:
		writeJSONError(w, 400, "unknown model settings action")
		return
	}
	_, _, current, e := readModelConfig(s.agentDir)
	if e != nil || current != revision {
		writeJSONError(w, 409, "model configuration changed; reload and try again")
		return
	}
	if request.Action == "remove-key" {
		err = deleteModelKey(s.agentDir, request.ID, config)
	} else {
		err = writeModelConfig(s.agentDir, config)
	}
	if errors.Is(err, errModelCredentialsChanged) {
		writeJSONError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeJSONError(w, 500, "could not save private model configuration")
		return
	}
	if request.Action == "remove-key" {
		delete(s.modelCatalogs, request.ID)
		if s.removedModelProviders == nil {
			s.removedModelProviders = make(map[string]struct{})
		}
		// The process-wide Pi model enumeration can still return this profile.
		s.removedModelProviders[request.ID] = struct{}{}
	}
	if manager, ok := s.chatSender.(interface{ ResourcesChanged() }); ok && (request.Action == "remove-key" || request.Action == "verify-effort") {
		manager.ResourcesChanged()
	} else if manager, ok := s.chatSender.(interface{ ModelsChanged() }); ok {
		manager.ModelsChanged()
	}
	_, providers, revision, err = readModelConfig(s.agentDir)
	if err != nil {
		writeJSONError(w, 500, "could not reload model configuration")
		return
	}
	writeJSON(w, 200, map[string]any{"profiles": s.modelProfiles(providers), "revision": revision})
}

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
	ID              string           `json:"id"`
	Label           string           `json:"label"`
	BaseURL         string           `json:"baseUrl"`
	API             string           `json:"api"`
	HasKey          bool             `json:"hasKey"`
	CatalogVerified bool             `json:"catalogVerified"`
	Applied         []map[string]any `json:"applied"`
	Available       []map[string]any `json:"available"`
}
type modelSettingsRequest struct {
	Action        string   `json:"action"`
	Revision      string   `json:"revision"`
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	BaseURL       string   `json:"baseUrl"`
	API           string   `json:"api"`
	Key           string   `json:"key"`
	CheckAPI      bool     `json:"checkApi"`
	ModelIDs      []string `json:"modelIds"`
	ModelID       string   `json:"modelId"`
	Vision        bool     `json:"vision"`
	Reasoning     bool     `json:"reasoning"`
	ThinkingLevel string   `json:"thinkingLevel"`
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
	raw, _ := json.Marshal([]any{p["baseUrl"], p["api"], p["yugoProtocol"], key})
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func publicModelBaseURL(base string) string {
	if u, err := url.Parse(base); err == nil && u.Hostname() != "" {
		u.User = nil
		u.RawQuery = ""
		u.Fragment = ""
		return u.String()
	}
	return ""
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

const fallbackContextWindow, fallbackOutputTokens = 128000, 32000

func publicModel(m map[string]any, provider, label string) map[string]any {
	result := map[string]any{"provider": provider, "providerLabel": label, "id": m["id"], "name": m["id"], "input": []string{"text"}, "reasoning": false}
	for _, key := range []string{"name", "input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap", "cost", "api", "supportsTools"} {
		if value, ok := m[key]; ok {
			result[key] = value
		}
	}
	if compat, ok := m["compat"].(map[string]any); ok && compat["forceAdaptiveThinking"] == true {
		result["adaptiveThinking"] = true
	}
	if id, ok := m["id"].(string); ok && fixedThinkingAlias.MatchString(id) {
		result["reasoning"] = false
	}
	if id, ok := m["id"].(string); ok {
		for i, name := range []string{"defaultContextWindow", "defaultMaxTokens"} {
			if limit := modelLimitsForID(id)[i]; limit > 0 {
				result[name] = limit
			}
		}
	}
	return result
}

func (s *Server) modelProfiles(providers map[string]any) []modelProfile {
	profiles := []modelProfile{}
	var settings struct{ ModelThinkingLevels map[string]string }
	if raw, err := os.ReadFile(filepath.Join(s.agentDir, "settings.json")); err == nil {
		_ = json.Unmarshal(raw, &settings)
	}
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
		row := modelProfile{ID: id, Label: label, BaseURL: publicModelBaseURL(base), API: api, HasKey: key != "", Applied: []map[string]any{}, Available: []map[string]any{}}
		overrides, _ := p["modelOverrides"].(map[string]any)
		for _, m := range configuredModels(p) {
			public := publicModel(m, id, label)
			if public["api"] == nil {
				public["api"] = api
			}
			if modelID, ok := m["id"].(string); ok {
				if level := settings.ModelThinkingLevels[id+"/"+modelID]; level != "" {
					public["defaultThinkingLevel"] = level
				}
				override, _ := overrides[modelID].(map[string]any)
				for _, field := range []string{"contextWindow", "maxTokens"} {
					if override[field] != nil {
						public[field] = override[field]
					}
				}
			}
			row.Applied = append(row.Applied, public)
		}
		row.Available = append(row.Available, row.Applied...)
		if catalog, ok := s.modelCatalogs[id]; ok && catalog.Signature == profileSignature(p, key) {
			row.CatalogVerified = true
			row.Available = []map[string]any{}
			metadataByID := map[string]map[string]any{}
			for _, m := range catalog.Models {
				row.Available = append(row.Available, publicModel(m, id, label))
				metadataByID[m["id"].(string)] = m
			}
			for _, m := range row.Applied {
				modelID, _ := m["id"].(string)
				metadata := metadataByID[modelID]
				if metadata["supportsTools"] == true {
					m["supportsTools"] = true
				}
				for i, name := range []string{"defaultContextWindow", "defaultMaxTokens"} {
					if limit := metadata[modelLimitFields[i]]; limit != nil {
						m[name] = limit
					}
				}
			}
		}
		profiles = append(profiles, row)
	}
	sort.Slice(profiles, func(i, j int) bool { return profiles[i].Label < profiles[j].Label })
	return profiles
}

func modelBaseURL(raw, api string) (*url.URL, error) {
	if base, routeAPI := modelProtocolRoute(raw); routeAPI == api {
		raw = base
	}
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid endpoint")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, errors.New("HTTPS is required except for a local model server")
	}
	switch api {
	case apiAnthropic:
		oldPath := u.Path
		if strings.HasSuffix(u.Path, "/v1/messages") || strings.HasSuffix(u.Path, "/v1/models") {
			u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/messages"), "/models")
		}
		for strings.HasSuffix(u.Path, "/v1") {
			u.Path = strings.TrimSuffix(u.Path, "/v1")
		}
		if u.Path != oldPath {
			u.RawPath = ""
		}
	case apiChat, apiResponses:
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

func editModelEndpoint(profile map[string]any, base, api string, replacingKey bool) (bool, error) {
	previous, _ := profile["baseUrl"].(string)
	if publicModelBaseURL(previous) == base {
		return false, nil
	}
	next, err := modelBaseURL(base, api)
	if err != nil || strings.TrimSpace(base) == "" {
		return false, errors.New("invalid endpoint")
	}
	if next.String() == previous {
		return false, nil
	}
	old, _ := url.Parse(previous)
	newOrigin := old == nil || old.Scheme != next.Scheme || !strings.EqualFold(old.Host, next.Host)
	if newOrigin && !replacingKey {
		return false, errors.New("enter a new key for a different API server")
	}
	if newOrigin && (profile["headers"] != nil || profile["oauth"] != nil) {
		return false, errors.New("provider has custom authentication or routes")
	}

	models := modelsWithOverrides(profile)
	for _, model := range models {
		if newOrigin && model["headers"] != nil {
			return false, errors.New("provider has custom authentication or routes")
		}
		modelBase, _ := model["baseUrl"].(string)
		if modelBase == "" {
			continue
		}
		if modelBase == previous {
			modelURL := *next
			if api == apiAnthropic {
				switch model["api"] {
				case apiChat, apiResponses:
					modelURL.Path += "/v1"
					modelURL.RawPath = ""
				case apiGemini:
					modelURL.Path += "/v1beta"
					modelURL.RawPath = ""
				}
			}
			model["baseUrl"] = modelURL.String()
			continue
		}
		if model["api"] == apiAnthropic {
			oldRoute, oldErr := modelBaseURL(previous, apiAnthropic)
			newRoute, newErr := modelBaseURL(next.String(), apiAnthropic)
			if oldErr == nil && newErr == nil && modelBase == oldRoute.String() {
				model["baseUrl"] = newRoute.String()
				continue
			}
		}
		if model["api"] == apiGemini && old != nil && strings.HasSuffix(old.Path, "/v1") {
			oldGemini := *old
			oldGemini.Path = strings.TrimSuffix(oldGemini.Path, "/v1") + "/v1beta"
			if modelBase == oldGemini.String() {
				newGemini := *next
				if strings.HasSuffix(newGemini.Path, "/v1") {
					newGemini.Path = strings.TrimSuffix(newGemini.Path, "/v1") + "/v1beta"
				}
				model["baseUrl"] = newGemini.String()
				continue
			}
		}
		if newOrigin {
			return false, errors.New("provider has custom authentication or routes")
		}
	}
	profile["baseUrl"] = next.String()
	return true, nil
}

func modelsWithOverrides(profile map[string]any) []map[string]any {
	models := configuredModels(profile)
	if overrides, ok := profile["modelOverrides"].(map[string]any); ok {
		for _, value := range overrides {
			if model, ok := value.(map[string]any); ok {
				models = append(models, model)
			}
		}
	}
	return models
}

func applyDetectedModelRoutes(profile map[string]any, models []map[string]any, previousAPI, defaultAPI string, upgradeOnly bool) bool {
	changed := false
	detected := make(map[string]map[string]any, len(models))
	for _, model := range models {
		id, _ := model["id"].(string)
		detected[id] = model
	}
	base, _ := profile["baseUrl"].(string)
	for _, model := range configuredModels(profile) {
		id, _ := model["id"].(string)
		oldAPI, _ := model["api"].(string)
		if oldAPI == "" {
			oldAPI = previousAPI
		}
		match := detected[id]
		newAPI, _ := match["api"].(string)
		if upgradeOnly {
			if newAPI == "" || newAPI == apiChat || newAPI == oldAPI || model["headers"] != nil ||
				(match["nativeAuth"] == nil && match["advertisedRoute"] != true) ||
				(oldAPI != apiChat && newAPI != nativeModelProtocol(id)) {
				continue
			}
			if custom, _ := model["baseUrl"].(string); custom != "" && custom != base {
				continue
			}
			if newAPI == apiAnthropic {
				bearer := profile["authHeader"] == true
				if (match["nativeAuth"] == "bearer" && !bearer) || (match["nativeAuth"] == "standard" && bearer) {
					continue
				}
			}
		}
		if newAPI == "" {
			if oldAPI != previousAPI {
				continue
			}
			newAPI = defaultAPI
		}
		if oldAPI != newAPI {
			model["api"] = newAPI
			changed = true
			if match != nil {
				model["reasoning"] = match["reasoning"] == true
			}
			for _, field := range []string{"compat", "thinkingLevelMap"} {
				delete(model, field)
				if match[field] != nil {
					model[field] = match[field]
				}
			}
			if upgradeOnly && match["baseUrl"] == nil {
				if route, err := nativeModelBase(base, newAPI); err == nil {
					model["baseUrl"] = route.String()
				}
			}
			if oldAPI == apiGemini && strings.HasSuffix(base, "/v1") && model["baseUrl"] == strings.TrimSuffix(base, "/v1")+"/v1beta" {
				delete(model, "baseUrl")
			}
		}
		if match["baseUrl"] != nil && (model["baseUrl"] == nil || model["baseUrl"] == base) {
			if model["baseUrl"] != match["baseUrl"] {
				model["baseUrl"] = match["baseUrl"]
				changed = true
			}
		}
	}
	return changed
}

type modelCatalogHTTPError int

func (e modelCatalogHTTPError) Error() string {
	return fmt.Sprintf("model service returned HTTP %d", e)
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
	if api == apiAnthropic || (api == apiChat && modelAPI == apiAnthropic) {
		u, err = modelBaseURL(base, apiAnthropic)
		if err != nil {
			return nil, err
		}
		u.Path += "/v1/models"
	} else {
		u.Path = strings.TrimRight(u.Path, "/") + "/models"
	}
	u.RawPath = ""
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	models := []map[string]any{}
	seen := map[string]bool{}
	probed := map[string]string{}
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
			return nil, modelCatalogHTTPError(response.StatusCode)
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
			catalogAPI, modelBase, nativeAuth := modelAPI, base, ""
			if pinned, _ := p["yugoProtocol"].(string); pinned != "" {
				delete(raw, "supported_endpoint_types")
				catalogAPI = pinned
			} else if catalogAPI == apiChat && raw["type"] == "model" && raw["display_name"] != nil && raw["created_at"] != nil {
				catalogAPI = apiAnthropic
			} else if p["preferNative"] == true && len(catalogStrings(raw["supported_endpoint_types"])) == 0 {
				native := nativeModelProtocol(id)
				if native != "" && native != catalogAPI {
					probe := native
					if native != apiResponses {
						probe += ":" + id
					}
					if _, checked := probed[probe]; !checked && len(probed) < 4 {
						probed[probe] = probeNativeModelRoute(ctx, client, base, native, id, key)
					}
					if nativeAuth = probed[probe]; nativeAuth != "" {
						if route, err := nativeModelBase(base, native); err == nil {
							catalogAPI, modelBase = native, route.String()
							m["baseUrl"] = modelBase
							m["nativeAuth"] = nativeAuth
						}
					}
				}
			}
			describeCatalogModel(m, raw, id, catalogAPI, modelBase)
			if advertised := advertisedModelProtocol(catalogStrings(raw["supported_endpoint_types"]), id, ""); advertised != "" && advertised == m["api"] {
				m["advertisedRoute"] = true
			}
			if m["contextWindow"] == nil || m["maxTokens"] == nil {
				limits := s.nativeModelLimits.lookup(ctx, id)
				for i, field := range modelLimitFields {
					if m[field] == nil && limits[i] > 0 {
						m[field] = limits[i]
					}
				}
			}
			for _, field := range []string{"display_name", "displayName"} {
				if name, ok := raw[field].(string); ok && len(name) <= 512 && !strings.Contains(name, key) {
					m["name"] = name
				}
			}
			if api == "google-generative-ai" {
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
	providers, _ := config["providers"].(map[string]any)
	normalizeModelEndpoints(providers)
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

func writeModelConfigWithoutLegacyKey(agent, id string, config map[string]any, replacing bool) error {
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
	raw := auth[id]
	var credential struct{ Type string }
	if len(raw) == 0 {
		return writeModelConfig(agent, config)
	}
	if json.Unmarshal(raw, &credential) != nil || credential.Type != "api_key" {
		if replacing {
			return errModelCredentialType
		}
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
var errModelCredentialType = errors.New("provider has a different sign-in method")

func setModelThinkingDefault(agent, qualified, level string) error {
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
	levels := map[string]string{}
	if value := settings["modelThinkingLevels"]; len(value) != 0 && json.Unmarshal(value, &levels) != nil {
		return errors.New("cannot read per-model thinking defaults")
	}
	if levels[qualified] == level {
		return nil
	}
	if level == "" {
		delete(levels, qualified)
	} else {
		if levels == nil {
			levels = make(map[string]string)
		}
		levels[qualified] = level
	}
	if len(levels) == 0 {
		delete(settings, "modelThinkingLevels")
	} else {
		settings["modelThinkingLevels"], _ = json.Marshal(levels)
	}
	next, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	current, err := os.ReadFile(path)
	if !(os.IsNotExist(err) && previous == nil) && (err != nil || !bytes.Equal(current, previous)) {
		return errModelCredentialsChanged
	}
	return writePrivateModelFile(path, append(next, '\n'))
}

func deleteModelConfiguration(agent, provider, modelID string, config map[string]any) error {
	settingsPath := filepath.Join(agent, "settings.json")
	info, err := os.Lstat(settingsPath)
	if errors.Is(err, os.ErrNotExist) {
		return writeModelConfig(agent, config)
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return errors.New("cannot read local Pi settings")
	}
	previous, err := os.ReadFile(settingsPath)
	var settings map[string]any
	if err != nil || json.Unmarshal(previous, &settings) != nil || settings == nil {
		return errors.New("cannot read local Pi settings")
	}
	changed := false
	if levels, ok := settings["modelThinkingLevels"].(map[string]any); ok {
		if _, ok := levels[provider+"/"+modelID]; ok {
			delete(levels, provider+"/"+modelID)
			if len(levels) == 0 {
				delete(settings, "modelThinkingLevels")
			}
			changed = true
		}
	}
	if settings["defaultProvider"] == provider && settings["defaultModel"] == modelID {
		delete(settings, "defaultProvider")
		delete(settings, "defaultModel")
		changed = true
	}
	if patterns, ok := settings["enabledModels"].([]any); ok {
		qualified := provider + "/" + modelID
		remaining := make([]any, 0, len(patterns))
		for _, item := range patterns {
			pattern, _ := item.(string)
			level, exact := strings.CutPrefix(pattern, qualified+":")
			switch {
			case pattern == qualified:
			case exact && (level == "off" || level == "minimal" || level == "low" || level == "medium" ||
				level == "high" || level == "xhigh" || level == "max"):
			default:
				remaining = append(remaining, item)
			}
		}
		if len(remaining) != len(patterns) {
			if len(remaining) == 0 {
				delete(settings, "enabledModels")
			} else {
				settings["enabledModels"] = remaining
			}
			changed = true
		}
	}
	if !changed {
		return writeModelConfig(agent, config)
	}
	next, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	if current, err := os.ReadFile(settingsPath); err != nil || !bytes.Equal(current, previous) {
		return errModelCredentialsChanged
	}
	if err := writePrivateModelFile(settingsPath, next); err != nil {
		return err
	}
	if err := writeModelConfig(agent, config); err != nil {
		if current, readErr := os.ReadFile(settingsPath); readErr == nil && bytes.Equal(current, next) {
			if restoreErr := writePrivateModelFile(settingsPath, previous); restoreErr != nil {
				return errors.New("model could not be removed and local settings could not be restored")
			}
		}
		return err
	}
	return nil
}

// Canonical custom models take precedence over a stale Pi enumeration cache.
// Only public metadata is sent to browsers; provider headers and keys stay local.
func (s *Server) appliedModels(fallback []map[string]any) ([]map[string]any, error) {
	s.modelConfigMu.Lock()
	defer s.modelConfigMu.Unlock()
	config, providers, _, err := readModelConfig(s.agentDir)
	if err != nil {
		return nil, err
	}
	if upgradeOfficialEfforts(providers) {
		if err := writeModelConfig(s.agentDir, config); err == nil {
			if manager, ok := s.chatSender.(interface{ ResourcesChanged() }); ok {
				manager.ResourcesChanged()
			}
		}
	}
	result := []map[string]any{}
	availableProviders := map[string]bool{}
	runtimeModels := map[[2]string]map[string]any{}
	for _, m := range fallback {
		id, _ := m["provider"].(string)
		modelID, _ := m["id"].(string)
		if _, removed := s.removedModelProviders[id]; removed && providers[id] == nil {
			continue
		}
		availableProviders[id] = true
		runtimeModels[[2]string{id, modelID}] = m
		if p, ok := providers[id].(map[string]any); ok && p["models"] != nil {
			continue
		}
		result = append(result, publicModel(m, id, id))
	}
	for _, p := range s.modelProfiles(providers) {
		if p.HasKey || availableProviders[p.ID] {
			profile, _ := providers[p.ID].(map[string]any)
			for i, configured := range configuredModels(profile) {
				modelID, _ := configured["id"].(string)
				if runtime := runtimeModels[[2]string{p.ID, modelID}]; runtime != nil {
					native := publicModel(runtime, p.ID, p.Label)
					if _, explicit := configured["reasoning"]; !explicit {
						p.Applied[i]["reasoning"] = native["reasoning"]
						if levelMap := native["thinkingLevelMap"]; levelMap != nil && configured["thinkingLevelMap"] == nil {
							p.Applied[i]["thinkingLevelMap"] = levelMap
						}
					}
					for _, field := range []string{"contextWindow", "maxTokens"} {
						if p.Applied[i][field] == nil && native[field] != nil {
							p.Applied[i][field] = native[field]
						}
					}
				}
			}
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
	request.Label = strings.TrimSpace(request.Label)
	request.Key = strings.TrimSpace(request.Key)
	request.BaseURL = strings.TrimSpace(request.BaseURL)
	if (request.Action == "add" || request.Action == "edit") &&
		(request.Label == "" || len(request.Label) > 100 ||
			(request.Action == "add" && request.Key == "") || len(request.Key) > 8192 || strings.ContainsAny(request.Key, "\r\n\x00")) {
		writeJSONError(w, 400, "a label and valid API key are required")
		return
	}
	configAffectsResources := false
	var editedCatalog *modelCatalog
	switch request.Action {
	case "add":
		var random [12]byte
		if _, e := rand.Read(random[:]); e != nil {
			writeJSONError(w, 500, "cannot create profile")
			return
		}
		id := "yugo-" + hex.EncodeToString(random[:])
		var models []map[string]any
		var u *url.URL
		var e error
		var bearerAuth bool
		_, pinned := modelProtocolRoute(request.BaseURL)
		if request.API == "" || request.API == "auto" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			s.modelConfigMu.Unlock()
			var detection modelProtocolDetection
			detection, e = s.detectModelProtocol(ctx, request.BaseURL, request.Key, "", "")
			u, request.API, models, bearerAuth = detection.BaseURL, detection.API, detection.Models, detection.BearerAuth
			cancel()
			s.modelConfigMu.Lock()
		} else {
			u, e = modelBaseURL(request.BaseURL, request.API)
			pinned = request.API
		}
		if e != nil {
			writeJSONError(w, 400, e.Error())
			return
		}
		profile := map[string]any{"name": request.Label, "baseUrl": u.String(), "api": request.API, "apiKey": literalModelKey(request.Key), "models": []any{}}
		if pinned != "" {
			profile["yugoProtocol"] = pinned
		}
		if bearerAuth {
			profile["authHeader"] = true
		}
		providers[id] = profile
		if models != nil {
			if s.modelCatalogs == nil {
				s.modelCatalogs = make(map[string]modelCatalog)
			}
			s.modelCatalogs[id] = modelCatalog{Signature: profileSignature(profile, request.Key), Models: models}
		}
	case "edit":
		base, _ := p["baseUrl"].(string)
		api, _ := p["api"].(string)
		if base == "" || api == "" {
			writeJSONError(w, 404, "key profile not found")
			return
		}
		if request.BaseURL == publicModelBaseURL(base) && request.Key == "" && !request.CheckAPI {
			p["name"] = request.Label
			break
		}
		oldKey := s.modelProfileKey(request.ID, p)
		signature := profileSignature(p, oldKey)
		address, explicit := modelProtocolRoute(request.BaseURL)
		endpointAPI := api
		if explicit != "" {
			endpointAPI = explicit
		}
		endpointChanged, err := editModelEndpoint(p, address, endpointAPI, request.Key != "")
		if err != nil {
			writeJSONError(w, 400, err.Error())
			return
		}
		configAffectsResources = endpointChanged || request.Key != "" || explicit != ""
		if configAffectsResources || request.CheckAPI {
			key := request.Key
			if key == "" {
				key = oldKey
			}
			if key == "" {
				writeJSONError(w, 400, "enter an API key to check compatibility")
				return
			}
			preferred := api
			pinned, _ := p["yugoProtocol"].(string)
			if endpointChanged {
				preferred = ""
				pinned = ""
			}
			if explicit != "" {
				pinned = explicit
			}
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			s.modelConfigMu.Unlock()
			detection, checkErr := s.detectModelProtocol(ctx, request.BaseURL, key, preferred, pinned)
			cancel()
			s.modelConfigMu.Lock()
			if checkErr != nil {
				writeJSONError(w, 400, checkErr.Error())
				return
			}
			checkedURL, checkedAPI, models := detection.BaseURL, detection.API, detection.Models
			_, currentProviders, currentRevision, readErr := readModelConfig(s.agentDir)
			current, _ := currentProviders[request.ID].(map[string]any)
			if readErr != nil || currentRevision != revision || current == nil || profileSignature(current, s.modelProfileKey(request.ID, current)) != signature {
				writeJSONError(w, 409, "model configuration changed; reload and try again")
				return
			}
			// Checking an existing key can upgrade individual models while
			// their catalog transport and unlisted routes continue to work.
			upgradeOnly := request.CheckAPI && !endpointChanged && explicit == "" && request.Key == ""
			if upgradeOnly {
				checkedURL, _ = modelBaseURL(base, api)
				checkedAPI = api
			}
			resolvedEndpointChanged, err := editModelEndpoint(p, checkedURL.String(), checkedAPI, request.Key != "")
			if err != nil {
				writeJSONError(w, 400, err.Error())
				return
			}
			p["api"] = checkedAPI
			if pinned != "" {
				p["yugoProtocol"] = pinned
			} else {
				delete(p, "yugoProtocol")
			}
			if detection.BearerAuth && canInferBearerAuth(p) {
				p["authHeader"] = true
				configAffectsResources = true
			}
			routesChanged := endpointChanged || resolvedEndpointChanged || api != checkedAPI
			if routesChanged || pinned == "" {
				configAffectsResources = applyDetectedModelRoutes(p, models, api, checkedAPI, upgradeOnly || !routesChanged) ||
					configAffectsResources || routesChanged
			}
			editedCatalog = &modelCatalog{Signature: profileSignature(p, key), Models: models}
		}
		p["name"] = request.Label
		if request.Key != "" {
			p["apiKey"] = literalModelKey(request.Key)
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
		base, _ := p["baseUrl"].(string)
		api, _ := p["api"].(string)
		pinned, _ := p["yugoProtocol"].(string)
		s.modelConfigMu.Unlock()
		detection, e := s.detectModelProtocol(ctx, base, key, api, pinned)
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
		models := detection.Models
		detected := map[string]map[string]any{}
		for _, m := range models {
			detected[m["id"].(string)] = m
		}
		changed := false
		if pinned == "" {
			changed = applyDetectedModelRoutes(current, models, api, api, true)
		}
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
		s.modelCatalogs[request.ID] = modelCatalog{Signature: profileSignature(current, key), Models: models}
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
		if request.ContextWindow < 0 || request.ContextWindow > maximumTokenLimit || request.MaxTokens < 0 || request.MaxTokens > maximumTokenLimit {
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
			delete(next, "nativeAuth")
			delete(next, "advertisedRoute")
			if next["api"] == apiAnthropic && m["nativeAuth"] == "bearer" && canInferBearerAuth(p) {
				p["authHeader"] = true
				configAffectsResources = true
			}
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
			} else if next["contextWindow"] == nil {
				next["contextWindow"] = fallbackContextWindow
			}
			if request.MaxTokens > 0 {
				next["maxTokens"] = request.MaxTokens
			} else if next["maxTokens"] == nil {
				next["maxTokens"] = fallbackOutputTokens
			}
			existing = append(existing, next)
			present[id] = true
		}
		p["models"] = existing
	case "edit-limits":
		if p == nil || request.ModelID == "" {
			writeJSONError(w, 404, "model not found")
			return
		}
		if request.ContextWindow < 1 || request.ContextWindow > maximumTokenLimit || request.MaxTokens < 1 || request.MaxTokens > maximumTokenLimit {
			writeJSONError(w, 400, "invalid model limits")
			return
		}
		found := false
		for _, model := range configuredModels(p) {
			if model["id"] == request.ModelID {
				model["contextWindow"] = request.ContextWindow
				model["maxTokens"] = request.MaxTokens
				found = true
				break
			}
		}
		if !found {
			writeJSONError(w, 404, "model not found")
			return
		}
		if overrides, ok := p["modelOverrides"].(map[string]any); ok {
			if override, ok := overrides[request.ModelID].(map[string]any); ok {
				if override["contextWindow"] != nil {
					override["contextWindow"] = request.ContextWindow
				}
				if override["maxTokens"] != nil {
					override["maxTokens"] = request.MaxTokens
				}
			}
		}
	case "edit-thinking-default":
		var model map[string]any
		for _, configured := range configuredModels(p) {
			if configured["id"] == request.ModelID {
				model = configured
				break
			}
		}
		if model == nil {
			writeJSONError(w, 404, "model not found")
			return
		}
		level := request.ThinkingLevel
		if level != "" {
			mapping, _ := model["thinkingLevelMap"].(map[string]any)
			mapped, explicit := mapping[level]
			ordinary := level == "off" || level == "minimal" || level == "low" || level == "medium" || level == "high"
			advanced := level == "xhigh" || level == "max"
			if model["reasoning"] != true || fixedThinkingAlias.MatchString(request.ModelID) ||
				!(ordinary && (!explicit || mapped != nil) || advanced && explicit && mapped != nil) {
				writeJSONError(w, 400, "thinking level is not available for this model")
				return
			}
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
		if overrides, ok := p["modelOverrides"].(map[string]any); ok {
			delete(overrides, request.ModelID)
		}
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
	switch request.Action {
	case "remove-key":
		err = writeModelConfigWithoutLegacyKey(s.agentDir, request.ID, config, false)
	case "edit":
		if request.Key != "" {
			err = writeModelConfigWithoutLegacyKey(s.agentDir, request.ID, config, true)
		} else {
			err = writeModelConfig(s.agentDir, config)
		}
	case "remove-model":
		err = deleteModelConfiguration(s.agentDir, request.ID, request.ModelID, config)
	case "edit-thinking-default":
		err = setModelThinkingDefault(s.agentDir, request.ID+"/"+request.ModelID, request.ThinkingLevel)
	default:
		err = writeModelConfig(s.agentDir, config)
	}
	if errors.Is(err, errModelCredentialsChanged) || errors.Is(err, errModelCredentialType) {
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
	if configAffectsResources {
		delete(s.modelCatalogs, request.ID)
	}
	if editedCatalog != nil {
		if s.modelCatalogs == nil {
			s.modelCatalogs = make(map[string]modelCatalog)
		}
		s.modelCatalogs[request.ID] = *editedCatalog
	}
	if manager, ok := s.chatSender.(interface{ ResourcesChanged() }); ok && (configAffectsResources || request.Action == "remove-key" || request.Action == "remove-model" || request.Action == "edit-limits" || request.Action == "edit-thinking-default") {
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

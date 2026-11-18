package server

import (
	"net/url"
	"strings"
)

// RepairSavedModelEndpoints upgrades profiles saved with a catalog URL as the
// runtime base, before Pi loads them into a worker or its enumeration cache.
func RepairSavedModelEndpoints(agentDir string) error {
	config, providers, revision, err := readModelConfig(agentDir)
	if err != nil || !normalizeModelEndpoints(providers) {
		return err
	}
	_, _, current, err := readModelConfig(agentDir)
	if err != nil {
		return err
	}
	if revision != current {
		return errModelCredentialsChanged
	}
	return writeModelConfig(agentDir, config)
}

func normalizeModelEndpoints(providers map[string]any) bool {
	changed := false
	for _, raw := range providers {
		profile, _ := raw.(map[string]any)
		base, _ := profile["baseUrl"].(string)
		providerAPI, _ := profile["api"].(string)
		if base == "" {
			continue
		}
		runtimeBase := base
		_, explicitAPI := modelProtocolRoute(base)
		if providerAPI == apiAnthropic || explicitAPI == providerAPI && explicitAPI != "" {
			if u, err := modelBaseURL(base, providerAPI); err == nil {
				runtimeBase = u.String()
				if runtimeBase != base {
					profile["baseUrl"] = runtimeBase
					changed = true
				}
			}
		}
		hasAnthropic := providerAPI == apiAnthropic
		for _, model := range modelsWithOverrides(profile) {
			api, _ := model["api"].(string)
			if api == "" {
				api = providerAPI
			}
			override, _ := model["baseUrl"].(string)
			if api == apiAnthropic {
				hasAnthropic = true
				configured := override
				if configured == "" {
					configured = runtimeBase
				}
				u, err := modelBaseURL(configured, apiAnthropic)
				if err == nil && u.String() != configured {
					model["baseUrl"] = u.String()
					changed = true
				}
			} else if _, explicitAPI := modelProtocolRoute(override); explicitAPI == api && explicitAPI != "" {
				if u, err := modelBaseURL(override, api); err == nil && u.String() != override {
					model["baseUrl"] = u.String()
					changed = true
				}
			} else if override == "" && providerAPI == apiAnthropic {
				// Models in a mixed gateway that use OpenAI or Gemini own their
				// version segment. Only Anthropic's SDK adds it internally.
				if u, err := modelBaseURL(runtimeBase, apiAnthropic); err == nil {
					switch api {
					case apiChat, apiResponses:
						u.Path += "/v1"
					case apiGemini:
						u.Path += "/v1beta"
					default:
						continue
					}
					u.RawPath = ""
					model["baseUrl"] = u.String()
					changed = true
				}
			}
		}
		// Packy's documented native Claude route uses Bearer authentication.
		// Leave an explicit auth policy or configured headers in control.
		if hasAnthropic && isPackyEndpoint(base) && canInferBearerAuth(profile) {
			profile["authHeader"] = true
			changed = true
		}
	}
	return changed
}

func canInferBearerAuth(profile map[string]any) bool {
	if profile["authHeader"] != nil || profile["headers"] != nil || profile["oauth"] != nil {
		return false
	}
	base, _ := profile["baseUrl"].(string)
	providerURL, err := url.Parse(base)
	if err != nil || providerURL.Host == "" {
		return false
	}
	for _, model := range modelsWithOverrides(profile) {
		if model["headers"] != nil {
			return false
		}
		if override, _ := model["baseUrl"].(string); override != "" {
			u, err := url.Parse(override)
			if err != nil || u.Scheme != providerURL.Scheme || !strings.EqualFold(u.Host, providerURL.Host) {
				return false
			}
		}
	}
	return true
}

func isPackyEndpoint(base string) bool {
	u, err := modelBaseURL(base, apiAnthropic)
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "cf.api.fan") && (u.Port() == "" || u.Port() == "443")
}

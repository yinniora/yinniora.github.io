package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func nativeModelProtocol(id string) string {
	id = strings.ToLower(id)
	if _, name, ok := strings.Cut(id, "/"); ok {
		id = name
	}
	switch {
	case strings.HasPrefix(id, "claude-"):
		return apiAnthropic
	case strings.HasPrefix(id, "gemini-") && !strings.Contains(id, "embedding"):
		return apiGemini
	case strings.HasPrefix(id, "gpt-image"), strings.Contains(id, "-audio"), strings.Contains(id, "-realtime"):
		return ""
	case strings.HasPrefix(id, "gpt-"), strings.HasPrefix(id, "chatgpt-"), strings.HasPrefix(id, "codex-"),
		id == "o1", id == "o3", id == "o4", strings.HasPrefix(id, "o1-"), strings.HasPrefix(id, "o3-"), strings.HasPrefix(id, "o4-"):
		return apiResponses
	}
	return ""
}

// Each inference SDK expects a different version prefix. The part before the
// version belongs to the gateway and stays in the route.
func nativeModelBase(base, api string) (*url.URL, error) {
	u, err := modelBaseURL(base, apiAnthropic)
	if err != nil {
		return nil, err
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1beta")
	u.RawPath = ""
	switch api {
	case apiResponses, apiChat:
		u.Path += "/v1"
	case apiGemini:
		u.Path += "/v1beta"
	}
	return u, nil
}

func advertisedModelProtocol(types map[string]bool, id, fallback string) string {
	supported := map[string]bool{
		apiAnthropic: types["anthropic"] || types[apiAnthropic],
		apiGemini:    types["gemini"] || types[apiGemini],
		apiResponses: types["openai-response"] || types["openai-responses"] || types["openai responses"],
		apiChat:      types["openai"] || types["openai-chat"] || types[apiChat],
	}
	native := nativeModelProtocol(id)
	if supported[native] {
		return native
	}
	if supported[fallback] {
		return fallback
	}
	for _, api := range []string{apiAnthropic, apiGemini, apiResponses, apiChat} {
		if supported[api] {
			return api
		}
	}
	return fallback
}

// Probe without conversation input. Claude needs an exact model to distinguish
// its route validation from a gateway's generic "missing model" response.
// A successful status, HTML, generic errors and redirects do not prove a route.
func probeNativeModelRoute(ctx context.Context, client *http.Client, base, api, id, key string) string {
	u, err := nativeModelBase(base, api)
	if err != nil {
		return ""
	}
	payload := "{}"
	switch api {
	case apiAnthropic:
		u.Path += "/v1/messages"
		data, _ := json.Marshal(map[string]string{"model": id})
		payload = string(data)
	case apiResponses:
		u.Path += "/responses"
	case apiGemini:
		if strings.ContainsAny(id, "/:?#%") {
			return ""
		}
		u.Path += "/models/" + id + ":countTokens"
	default:
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for _, bearer := range []bool{false, true} {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(payload))
		if err != nil {
			return ""
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		switch {
		case api == apiAnthropic && !bearer:
			req.Header.Set("x-api-key", key)
		case api == apiGemini:
			req.Header.Set("x-goog-api-key", key)
		default:
			req.Header.Set("Authorization", "Bearer "+key)
		}
		if api == apiAnthropic {
			req.Header.Set("anthropic-version", "2023-06-01")
		}
		res, err := client.Do(req)
		if err != nil {
			return ""
		}
		body, readErr := io.ReadAll(io.LimitReader(res.Body, 16<<10))
		res.Body.Close()
		if !bearer && api == apiAnthropic && (res.StatusCode == 401 || res.StatusCode == 403) {
			continue
		}
		if readErr != nil || !nativeRouteValidation(res.StatusCode, body, api) {
			return ""
		}
		if bearer {
			return "bearer"
		}
		return "standard"
	}
	return ""
}

func nativeRouteValidation(status int, body []byte, api string) bool {
	if status != 400 && status != 422 {
		return false
	}
	var payload struct {
		Error struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Param   string `json:"param"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return false
	}
	detail := payload.Error
	msg := strings.ToLower(detail.Message)
	if strings.Contains(msg, "not supported") || strings.Contains(msg, "unsupported") ||
		strings.Contains(msg, "does not support") || strings.Contains(msg, "not allowed") ||
		strings.Contains(msg, "not found") || strings.Contains(msg, "不支持") {
		return false
	}
	missing := strings.Contains(msg, "required") || strings.Contains(msg, "missing") ||
		strings.Contains(msg, "empty") || strings.Contains(msg, "provide") ||
		strings.Contains(msg, "缺少") || strings.Contains(msg, "必填") || strings.Contains(msg, "为空")
	switch api {
	case apiAnthropic:
		return missing && (detail.Type == "invalid_request_error" || detail.Type == "invalid_request") &&
			(strings.Contains(msg, "messages") || strings.Contains(msg, "max_tokens") || strings.Contains(msg, "消息"))
	case apiResponses:
		// Responses also returns invalid_request_error with param=input or model.
		return detail.Type == "invalid_request_error" && (detail.Param == "input" || detail.Param == "model" ||
			missing && (strings.Contains(msg, "input") || strings.Contains(msg, "model")))
	case apiGemini:
		return missing && detail.Status == "INVALID_ARGUMENT" && strings.Contains(msg, "content")
	}
	return false
}

package server

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pi-web/internal/relay"
)

const relayActivationPrefix = "yugopi-relay:"

type relayActivation struct {
	ServerURL string `json:"serverUrl"`
	Token     string `json:"token"`
}

func parseRelayActivation(code string) (relayActivation, error) {
	invalid := errors.New("invalid relay activation code")
	var activation relayActivation
	encoded, found := strings.CutPrefix(strings.TrimSpace(code), relayActivationPrefix)
	if !found || len(encoded) > 1024 {
		return activation, invalid
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || json.Unmarshal(data, &activation) != nil {
		return relayActivation{}, invalid
	}
	u, err := url.Parse(activation.ServerURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return relayActivation{}, invalid
	}
	secret, err := hex.DecodeString(activation.Token)
	if err != nil || len(secret) != 32 {
		return relayActivation{}, invalid
	}
	activation.ServerURL = u.Scheme + "://" + u.Host
	return activation, nil
}

func redeemRelayActivation(ctx context.Context, activation relayActivation) (relay.ServerProfile, error) {
	var profile relay.ServerProfile
	client := &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, activation.ServerURL+"/setup", nil)
	if err != nil {
		return profile, err
	}
	request.Header.Set("Authorization", "Bearer "+activation.Token)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return profile, errors.New("cannot verify relay HTTPS connection")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return profile, errors.New("relay activation code expired or was already used")
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&profile) != nil || strings.TrimRight(profile.ServerURL, "/") != activation.ServerURL {
		return relay.ServerProfile{}, errors.New("invalid relay activation response")
	}
	return profile, nil
}

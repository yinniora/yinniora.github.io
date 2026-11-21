package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const directSignalHealth = "yugo-pi-direct-signal"

func configureTailscaleSignal(ctx context.Context, localPort int) (endpoint, consentURL string, err error) {
	port := strconv.Itoa(localPort)
	base, _, err := configureTailscaleTarget(ctx, port, "http://127.0.0.1:"+port)
	if err != nil {
		var consent tailscaleConsentRequired
		if errors.As(err, &consent) {
			return "", consent.url, err
		}
		return "", "", err
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || !strings.HasSuffix(u.Hostname(), ".ts.net") {
		return "", "", errors.New("Tailscale DNS name is unavailable")
	}
	if err := verifyTailscaleSignal(ctx, u); err != nil {
		return "", "", err
	}
	u.Scheme = "wss"
	u.Path = "/remote-signal"
	return u.String(), "", nil
}

func verifyTailscaleSignal(ctx context.Context, base *url.URL) error {
	u := *base
	u.Path = "/healthz"
	client := &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("cannot reach the Tailscale HTTPS signaling address")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 128))
	if err != nil || response.StatusCode != http.StatusOK || string(body) != directSignalHealth {
		return errors.New("the Tailscale endpoint does not reach YuGo Pi signaling")
	}
	return nil
}

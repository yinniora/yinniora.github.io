package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"pi-web/internal/auth"
	"pi-web/internal/relay"
	"strings"
	"testing"
)

func TestConfigureTailscaleSettingsUsesLocalApproval(t *testing.T) {
	var reason string
	s := deviceTestServer(t, func(_ context.Context, target string) error { reason = target; return nil })
	dir := t.TempDir()
	host, err := relay.NewHost(filepath.Join(dir, "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	s.remoteControl, err = relay.NewController(host, filepath.Join(dir, "connection.json"), relay.ConnectionConfig{})
	if err != nil {
		t.Fatal(err)
	}
	const endpoint = "wss://test.tail.ts.net:31417/remote-signal"
	s.privateSignal = func(context.Context) (string, string, error) {
		if reason != "remote-server:Tailscale" {
			t.Fatal("started configuration before local authentication")
		}
		return endpoint, "", nil
	}
	r := httptest.NewRequest("POST", "http://localhost/api/remote-settings", strings.NewReader(`{"action":"tailscale"}`))
	r.RemoteAddr = "127.0.0.1:123"
	w := httptest.NewRecorder()
	s.handleRemoteSettings(w, r)
	if w.Code != 200 || s.remoteControl.DirectURL() != endpoint {
		t.Fatalf("private signaling not saved: %s", w.Body)
	}
	if current := s.remoteControl.Bootstrap()["signalUrl"]; current != "" {
		t.Fatalf("expected pure Tailscale, got broker %q", current)
	}
}

func TestRelayActivationAcceptsOnlyAnHTTPSOriginAndStrongCode(t *testing.T) {
	encode := func(origin, token string) string {
		payload := fmt.Sprintf(`{"serverUrl":%q,"token":%q}`, origin, token)
		return relayActivationPrefix + base64.RawURLEncoding.EncodeToString([]byte(payload))
	}
	secret := strings.Repeat("a1", 32)
	activation, err := parseRelayActivation(encode("https://relay.example/", secret))
	if err != nil || activation.ServerURL != "https://relay.example" || activation.Token != secret {
		t.Fatal("valid relay origin or secret rejected")
	}
	for _, input := range []string{
		encode("http://relay.example", secret),
		encode("https://relay.example/hijack", secret),
		encode("https://fake@relay.example", secret),
		encode("https://relay.example", "123456"),
	} {
		if _, err := parseRelayActivation(input); err == nil {
			t.Fatal("accepted invalid activation")
		}
	}
}

func TestRemoteServerSettingsRequireLocalMacAuthentication(t *testing.T) {
	var reason string
	s := deviceTestServer(t, func(ctx context.Context, name string) error { reason = name; return fmt.Errorf("cancelled") })
	host, err := relay.NewHost(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	s.remoteControl, err = relay.NewController(host, filepath.Join(t.TempDir(), "connection.json"), relay.ConnectionConfig{})
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "POST"} {
		r := httptest.NewRequest(method, "http://localhost/api/remote-settings", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:123"
		r = auth.WithApprovedDevice(r, "remote-key")
		w := httptest.NewRecorder()
		s.handleRemoteSettings(w, r)
		if w.Code != 403 {
			t.Fatal("remote device may manage server settings")
		}
	}
	r := httptest.NewRequest("POST", "http://localhost/api/remote-settings", strings.NewReader(fmt.Sprintf(`{"serverUrl":"https://relay.example","room":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","hostToken":"%s","turnSecret":"%s","clientSecret":"%s"}`, strings.Repeat("h", 64), strings.Repeat("t", 64), strings.Repeat("c", 64))))
	r.RemoteAddr = "127.0.0.1:123"
	w := httptest.NewRecorder()
	s.handleRemoteSettings(w, r)
	if w.Code != 403 || reason != "remote-server:https://relay.example" {
		t.Fatal("save skipped destination-bound Mac authentication", w.Code, reason)
	}
	r = httptest.NewRequest("GET", "http://localhost/api/remote-settings", nil)
	r.RemoteAddr = "127.0.0.1:123"
	w = httptest.NewRecorder()
	s.handleRemoteSettings(w, r)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("redacted settings unavailable")
	}
}

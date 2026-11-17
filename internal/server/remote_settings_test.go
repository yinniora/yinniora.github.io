package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"pi-web/internal/auth"
	"pi-web/internal/relay"
	"strings"
	"testing"
)

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

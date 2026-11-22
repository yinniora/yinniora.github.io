package server

import (
	"errors"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestNewPushManager_CreatesDirUnderAgentPath(t *testing.T) {
	tmp := t.TempDir()
	pm, err := NewPushManager(tmp)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tmp, "pi-web")
	if pm.storeDir != want {
		t.Fatalf("storeDir = %s, want %s", pm.storeDir, want)
	}
	if _, err := os.Stat(pm.storeDir); err != nil {
		t.Fatalf("dir not created: %v", err)
	}
}

func TestNewPushManager_PersistsVapidKeys(t *testing.T) {
	tmp := t.TempDir()
	pm1, err := NewPushManager(tmp)
	if err != nil {
		t.Fatal(err)
	}
	pub1 := pm1.PublicKey()
	if pub1 == "" {
		t.Fatal("expected non-empty public key")
	}

	// Second instance should load existing keys
	pm2, err := NewPushManager(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if pm2.PublicKey() != pub1 {
		t.Fatal("expected same public key after reload")
	}
}

func TestValidPushEndpoint(t *testing.T) {
	cases := []struct {
		endpoint string
		want     bool
	}{
		{"https://fcm.googleapis.com/fcm/send/abc123", true},
		{"https://updates.push.services.mozilla.com/wpush/v2/xyz", true},
		{"https://web.push.apple.com/fixture", true},
		{"https://localhost/", false},
		{"https://127.0.0.1/", false},
		{"https://[::1]/", false},
		{"https://100.64.0.1/", false},
		{"", false},
		{"http://fcm.googleapis.com/fcm/send/abc", false}, // cleartext
		{"http://127.0.0.1:31415/api/chat", false},        // SSRF to loopback
		{"https:///fcm/send/abc", false},                  // no host
		{"file:///etc/passwd", false},
		{"ftp://example.com/x", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := validPushEndpoint(c.endpoint); got != c.want {
			t.Errorf("validPushEndpoint(%q) = %v, want %v", c.endpoint, got, c.want)
		}
	}
}

func TestPushClientChecksPublicIPAndDoesNotFollowRedirects(t *testing.T) {
	for _, tt := range []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"2001:4860:4860::8888", true},
		{"64:ff9b::8.8.8.8", true},
		{"169.254.169.254", false},
		{"192.168.0.4", false},
		{"100.64.0.1", false},
		{"::ffff:127.0.0.1", false},
		{"64:ff9b::127.0.0.1", false},
	} {
		if got := publicPushIP(netip.MustParseAddr(tt.ip)); got != tt.want {
			t.Errorf("publicPushIP(%s) = %t, want %t", tt.ip, got, tt.want)
		}
	}
	client := newPushHTTPClient()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("push credentials must be sent directly to the approved destination")
	}
	if !errors.Is(client.CheckRedirect(nil, nil), http.ErrUseLastResponse) {
		t.Fatal("push client must not follow redirects")
	}
}

func TestNewPushManager_MigratesOldWebDir(t *testing.T) {
	tmp := t.TempDir()
	oldDir := filepath.Join(tmp, "web")
	newDir := filepath.Join(tmp, "pi-web")

	if err := os.MkdirAll(oldDir, 0700); err != nil {
		t.Fatal(err)
	}
	// Write old VAPID keys
	oldVapid := []byte(`{"publicKey":"pub","privateKey":"priv"}`)
	if err := os.WriteFile(filepath.Join(oldDir, "vapid.json"), oldVapid, 0600); err != nil {
		t.Fatal(err)
	}
	// Write old subscriptions
	oldSubs := []byte(`{"sub1":{"endpoint":"e","keys":{"p256dh":"p","auth":"a"}}}`)
	if err := os.WriteFile(filepath.Join(oldDir, "push-subs.json"), oldSubs, 0600); err != nil {
		t.Fatal(err)
	}

	pm, err := NewPushManager(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if pm.storeDir != newDir {
		t.Fatalf("storeDir = %s, want %s", pm.storeDir, newDir)
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatal("old web dir should have been removed")
	}
	if pm.PublicKey() != "pub" {
		t.Fatalf("expected migrated public key pub, got %s", pm.PublicKey())
	}
}

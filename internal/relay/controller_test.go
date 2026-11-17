package relay

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteServerConfigurationVerifiesAndKeepsPrivateIdentity(t *testing.T) {
	b := securedBroker()
	srv := httptest.NewTLSServer(b)
	defer srv.Close()
	host, err := NewHost(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "remote", "connection.json")
	c, err := NewController(host, file, ConnectionConfig{ClientURL: b.Origin + "/"})
	if err != nil {
		t.Fatal(err)
	}
	c.client.Transport = srv.Client().Transport
	p := ServerProfile{ServerURL: srv.URL, Room: b.Room, HostToken: b.HostToken, TURNSecret: b.TURNSecret, ClientSecret: b.ClientSecret}
	if err = c.Save(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(file)
	if info.Mode().Perm() != 0600 {
		t.Fatal("configuration is not private")
	}
	public := c.Bootstrap()
	if public["fingerprint"] != host.Fingerprint || public["relayAuth"] != true {
		t.Fatal("Mac identity lost or authentication disabled")
	}
	for _, value := range c.PublicSettings() {
		if str, ok := value.(string); ok && (str == p.HostToken || str == p.ClientSecret || str == p.TURNSecret) {
			t.Fatal("credential returned by settings")
		}
	}
	restored, err := NewController(host, file, ConnectionConfig{ClientURL: b.Origin + "/"})
	if err != nil || restored.Bootstrap()["signalUrl"] != public["signalUrl"] {
		t.Fatal("saved configuration not restored", err)
	}
	old, _ := os.ReadFile(file)
	bad := p
	bad.ClientSecret = strings.Repeat("x", 64)
	if c.Save(context.Background(), bad) == nil {
		t.Fatal("wrong enrollment secret accepted")
	}
	now, _ := os.ReadFile(file)
	if string(old) != string(now) {
		t.Fatal("failed verification replaced working configuration")
	}
	if c.Save(context.Background(), ServerProfile{ServerURL: "https://other.example", Room: p.Room}) == nil {
		t.Fatal("existing credentials copied to new server")
	}
	p.ServerURL = "http://127.0.0.1"
	if c.Save(context.Background(), p) == nil {
		t.Fatal("plaintext server accepted")
	}
}

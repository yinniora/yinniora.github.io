package relay

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
	// Windows FileMode does not report POSIX owner/group permission bits.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
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

func TestDirectSignalingProfilePreservesBrokerAndSurvivesRestart(t *testing.T) {
	const oldDirect = "wss://host.tail.example/old"
	const newDirect = "wss://host.tail.example/remote-signal"
	path := filepath.Join(t.TempDir(), "remote", "connection.json")
	host := &Host{}
	baseline := ConnectionConfig{
		DirectURL: oldDirect,
		SignalURL: "wss://broker.example/signal",
		ICEURL:    "https://broker.example/ice",
	}
	c, err := NewController(host, path, baseline)
	if err != nil {
		t.Fatal(err)
	}
	if c.DirectURL() != oldDirect || c.PublicSettings()["directConfigured"] != true {
		t.Fatal("existing direct URL not recognized")
	}
	if err = c.SetDirectURL(newDirect); err != nil {
		t.Fatal(err)
	}
	if c.Bootstrap()["signalUrl"] != baseline.SignalURL || c.Bootstrap()["iceUrl"] != baseline.ICEURL {
		t.Fatal("direct route replaced broker")
	}
	if err = c.SetDirectURL("ws://invalid.example/"); err == nil || c.DirectURL() != newDirect {
		t.Fatal("insecure direct route was accepted")
	}
	restored, err := NewController(host, path, baseline)
	if err != nil || restored.DirectURL() != newDirect {
		t.Fatal("saved direct route did not persist across restart", err)
	}
	info, err := os.Stat(c.directProfilePath())
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("direct configuration is not private", err)
	}
	if err = restored.SetDirectURL(""); err != nil {
		t.Fatal(err)
	}
	restored, err = NewController(host, path, baseline)
	if err != nil || restored.DirectURL() != "" || restored.PublicSettings()["directConfigured"] != false {
		t.Fatal("persisted disable did not suppress the old environment route", err)
	}
}

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"pi-web/internal/auth"
	"strings"
	"testing"
	"time"
)

func deviceTestServer(t *testing.T, approve func(context.Context, string) error) *Server {
	t.Helper()
	s := newTestServer(t)
	d, err := newDeviceAccess(s.db, approve)
	if err != nil {
		t.Fatal(err)
	}
	s.devices = d
	d.bootstrap = func() map[string]any {
		return map[string]any{"clientUrl": "https://client.example/", "signalUrl": "wss://relay.example/signal", "iceUrl": "https://relay.example/ice", "fingerprint": "test"}
	}
	return s
}
func TestPairRequiresActualLocalMacApproval(t *testing.T) {
	var approved int
	s := deviceTestServer(t, func(context.Context, string) error { approved++; return fmt.Errorf("cancelled") })
	for _, tc := range []struct{ host, remote, device string }{{"localhost", "198.51.100.2:123", ""}, {"relay.example", "127.0.0.1:123", ""}, {"localhost", "127.0.0.1:123", "approved"}, {"localhost", "127.0.0.1:123", ""}} {
		r := httptest.NewRequest("POST", "http://"+tc.host+"/api/devices", strings.NewReader(`{"action":"pair","name":"Phone"}`))
		r.RemoteAddr = tc.remote
		if tc.device != "" {
			r = auth.WithApprovedDevice(r, tc.device)
		}
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		if w.Code != 403 {
			t.Fatalf("accepted %v: %d", tc, w.Code)
		}
	}
	if approved != 1 || len(s.devices.tickets) != 0 {
		t.Fatal("Mac approval bypass or ticket created after cancellation")
	}
}
func TestPairTicketSingleUseExpiryAndRevoke(t *testing.T) {
	s := deviceTestServer(t, func(context.Context, string) error { return nil })
	pair := func() string {
		r := httptest.NewRequest("POST", "http://localhost/api/devices", strings.NewReader(`{"action":"pair","name":"Phone"}`))
		r.RemoteAddr = "127.0.0.1:123"
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		if w.Code != 200 {
			t.Fatalf("pair %d %s", w.Code, w.Body)
		}
		var out struct{ URL string }
		json.Unmarshal(w.Body.Bytes(), &out)
		u, _ := url.Parse(out.URL)
		if u.RawQuery != "" {
			t.Fatal("ticket leaked in URL query")
		}
		b, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(u.Fragment, "pair="))
		var meta struct{ Ticket string }
		json.Unmarshal(b, &meta)
		return meta.Ticket
	}
	ticket := pair()
	pub := json.RawMessage(`{"kty":"EC"}`)
	if err := s.devices.authorize(context.Background(), "first", pub, ticket); err != nil {
		t.Fatal(err)
	}
	if err := s.devices.authorize(context.Background(), "second", pub, ticket); err == nil {
		t.Fatal("ticket reused")
	}
	if err := s.devices.authorize(context.Background(), "first", pub, ticket); err != nil {
		t.Fatal("approved device could not recover after a lost enrollment response:", err)
	}
	fresh := pair()
	if err := s.devices.authorize(context.Background(), "first", pub, fresh); err != nil {
		t.Fatal(err)
	}
	if len(s.devices.tickets) != 0 {
		t.Fatal("fresh ticket was not consumed by an already approved device")
	}
	if err := s.devices.authorize(context.Background(), "third", pub, fresh); err == nil {
		t.Fatal("approved device left its fresh ticket usable by another key")
	}
	if err := s.devices.authorize(context.Background(), "stranger", pub, ""); err == nil {
		t.Fatal("unapproved device")
	}
	closed := false
	unwatch := s.devices.watch("first", func() { closed = true })
	defer unwatch()
	if err := s.devices.revoke("first"); err != nil {
		t.Fatal(err)
	}
	if !closed {
		t.Fatal("revocation did not disconnect")
	}
	if err := s.devices.authorize(context.Background(), "first", pub, ""); err == nil {
		t.Fatal("revoked key authenticated")
	}
	if err := s.devices.authorize(context.Background(), "first", pub, ticket); err == nil {
		t.Fatal("revoked key recovered using a spent ticket")
	}
	ticket = pair()
	s.devices.now = func() time.Time { return time.Now().Add(4 * time.Minute) }
	if err := s.devices.authorize(context.Background(), "late", pub, ticket); err == nil {
		t.Fatal("expired ticket authenticated")
	}
}
func TestRemoteHTTPGatedEvenWithForwardedLoopback(t *testing.T) {
	s := deviceTestServer(t, nil)
	r := httptest.NewRequest("GET", "http://localhost/api/settings", nil)
	r.RemoteAddr = "198.51.100.1:1"
	r.Header.Set("X-Forwarded-For", "127.0.0.1")
	w := httptest.NewRecorder()
	s.WrapDevices(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), false).ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("remote HTTP allowed: %d", w.Code)
	}
}

func TestDeviceDetailsAndRemoval(t *testing.T) {
	s := deviceTestServer(t, nil)
	stamp := "2026-11-17T12:34:56Z"
	for _, id := range []string{"phone-one", "phone-two"} {
		if _, err := s.db.Exec(`INSERT INTO approved_devices(id,public_key,name,created_at,last_seen) VALUES(?,?,?,?,?)`, id, `{}`, "iPhone", stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	request := func(body string, device string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://localhost/api/devices", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:123"
		if device != "" {
			r = auth.WithApprovedDevice(r, device)
		}
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		return w
	}
	if w := request(`{"action":"identify","id":"phone-two","features":{"os":"iOS 26.1","browser":"Safari 26","app":"standalone"}}`, "phone-one"); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var one, two string
	s.db.QueryRow(`SELECT features FROM approved_devices WHERE id='phone-one'`).Scan(&one)
	s.db.QueryRow(`SELECT features FROM approved_devices WHERE id='phone-two'`).Scan(&two)
	if !strings.Contains(one, "iOS 26.1") || two != "{}" {
		t.Fatal("device changed another identity's features")
	}
	for _, body := range []string{`{"action":"delete","id":"phone-two"}`, `{"action":"pair","name":"other"}`} {
		if w := request(body, "phone-one"); w.Code != 403 {
			t.Fatal("remote device gained administration", w.Code)
		}
	}
	if w := request(`{"action":"identify","features":{"os":"iOS","app":"browser"}}`, ""); w.Code != 403 {
		t.Fatal("unapproved metadata accepted")
	}
	closed := false
	unwatch := s.devices.watch("phone-one", func() { closed = true })
	defer unwatch()
	r := httptest.NewRequest("GET", "http://localhost/api/devices", nil)
	r.RemoteAddr = "127.0.0.1:123"
	w := httptest.NewRecorder()
	s.handleDevices(w, r)
	var data struct {
		Devices []struct {
			ID, CreatedAt, LastSeen string
			Connected               bool
			Features                deviceFeatures
		}
	}
	if json.Unmarshal(w.Body.Bytes(), &data) != nil || len(data.Devices) != 2 || data.Devices[0].CreatedAt != stamp || !data.Devices[0].Connected || data.Devices[0].Features.App != "standalone" {
		t.Fatal("missing device details", w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("device details cacheable")
	}
	if w := request(`{"action":"delete","id":"phone-one"}`, ""); w.Code != 200 {
		t.Fatal(w.Body)
	}
	if !closed {
		t.Fatal("removed device remains connected")
	}
	if err := s.devices.authorize(context.Background(), "phone-one", json.RawMessage(`{}`), ""); err == nil {
		t.Fatal("removed key authenticated")
	}
	denied := false
	s.devices.watch("phone-one", func() { denied = true })()
	if !denied {
		t.Fatal("removed key reattached a connection")
	}
	if w := request(`{"action":"identify","features":{"os":"iOS","app":"browser"}}`, "phone-one"); w.Code != 403 {
		t.Fatal("deleted row recreated by metadata")
	}
	if w := request(`{"action":"delete","id":"phone-one"}`, ""); w.Code != 200 {
		t.Fatal("repeat removal failed")
	}
	s.devices.revoke("phone-two")
	w = httptest.NewRecorder()
	s.handleDevices(w, r)
	if !strings.Contains(w.Body.String(), `"devices":[]`) {
		t.Fatal("revoked devices remain in the visible list", w.Body)
	}
}

func TestExistingDeviceMigrationPreservesApproval(t *testing.T) {
	s := newTestServer(t)
	if _, err := s.db.Exec(deviceSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO approved_devices(id,public_key,name,created_at,last_seen) VALUES('old-key','{}','Phone','paired-time','seen-time')`); err != nil {
		t.Fatal(err)
	}
	d, err := newDeviceAccess(s.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	var id, created, features string
	if err = d.db.QueryRow(`SELECT id,created_at,features FROM approved_devices`).Scan(&id, &created, &features); err != nil || id != "old-key" || created != "paired-time" || features != "{}" {
		t.Fatal("migration replaced existing approval", err)
	}
}

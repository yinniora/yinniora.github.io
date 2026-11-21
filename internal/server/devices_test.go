package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-web/internal/auth"
	"pi-web/internal/relay"
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

func TestDirectPairingWorksWithoutRelay(t *testing.T) {
	const direct = "wss://host.tail.example/remote-signal"
	var approvals int
	s := deviceTestServer(t, func(context.Context, string) error { approvals++; return nil })
	s.devices.bootstrap = func() map[string]any {
		return map[string]any{
			"version": 1, "clientUrl": "https://client.example/", "fingerprint": "test",
			"directUrl": direct,
		}
	}
	assertStatus := func(method, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://localhost/api/devices", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:123"
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		if w.Code != status {
			t.Fatalf("%s devices returned %d, want %d: %s", method, w.Code, status, w.Body)
		}
		return w
	}
	status := assertStatus("GET", "", 200)
	var pairing struct{ CanPair bool }
	if err := json.Unmarshal(status.Body.Bytes(), &pairing); err != nil || !pairing.CanPair {
		t.Fatal("verified direct route should allow pairing:", err)
	}
	reply := assertStatus("POST", `{"action":"pair","name":"Phone","qrVersion":2}`, 200)
	var out struct{ URL string }
	if err := json.Unmarshal(reply.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	qr, err := url.Parse(out.URL)
	if err != nil || qr.Host != "client.example" || qr.RawQuery != "" {
		t.Fatal("invalid pairing link", err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(qr.Fragment, "pair="))
	if err != nil {
		t.Fatal(err)
	}
	var ticket struct{ DirectURL, Ticket, SignalURL, ICEURL, RelayTicket string }
	if err = json.Unmarshal(payload, &ticket); err != nil ||
		ticket.DirectURL != direct || len(ticket.Ticket) != 64 ||
		ticket.SignalURL != "" || ticket.ICEURL != "" || ticket.RelayTicket != "" || approvals != 1 {
		t.Fatal("direct pairing should carry only the private route and its authorized device ticket:", err)
	}
	if err = s.devices.authorize(context.Background(), "phone", json.RawMessage(`{}`), ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	if err = s.devices.authorize(context.Background(), "stranger", json.RawMessage(`{}`), ticket.Ticket); err == nil {
		t.Fatal("direct pairing ticket was accepted twice")
	}
}

func TestRescanAddsRelayAndLANToExistingDirectDevice(t *testing.T) {
	const direct = "wss://host.tail.example/remote-signal"
	const lan = "wss://192.168.2.9:43124/remote-signal"
	const client = "https://client.example/"
	room := strings.Repeat("r", 32)
	signal, ice := "wss://relay.example/signal?room="+room, "https://relay.example/ice?room="+room
	var approvals int
	s := deviceTestServer(t, func(context.Context, string) error { approvals++; return nil })
	host, err := relay.NewHost(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	configure := func(config relay.ConnectionConfig) {
		t.Helper()
		control, err := relay.NewController(host, filepath.Join(t.TempDir(), "connection.json"), config)
		if err != nil {
			t.Fatal(err)
		}
		s.remoteControl, s.devices.bootstrap = control, control.Bootstrap
	}
	code := func(request string) map[string]any {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "http://localhost/api/devices", strings.NewReader(request))
		r.RemoteAddr = "127.0.0.1:123"
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		var reply struct{ URL string }
		if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil || w.Code != http.StatusOK {
			t.Fatalf("pair returned %d: %s", w.Code, w.Body)
		}
		u, err := url.Parse(reply.URL)
		if err != nil || u.Hostname() != "client.example" || u.RawQuery != "" {
			t.Fatal("invalid pairing URL", err)
		}
		data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(u.Fragment, "pair="))
		if err != nil {
			t.Fatal(err)
		}
		var metadata map[string]any
		if err := json.Unmarshal(data, &metadata); err != nil {
			t.Fatal(err)
		}
		return metadata
	}
	configure(relay.ConnectionConfig{ClientURL: client, DirectURL: direct})
	first := code(`{"action":"pair","name":"Personal phone"}`)
	key := json.RawMessage(`{"kty":"EC","crv":"P-256"}`)
	if err := s.AuthorizeRemoteDevice(context.Background(), "phone-key", key, first["ticket"].(string)); err != nil {
		t.Fatal(err)
	}
	var originalCreated string
	if err := s.db.QueryRow(`SELECT created_at FROM approved_devices WHERE id='phone-key'`).Scan(&originalCreated); err != nil {
		t.Fatal(err)
	}
	configure(relay.ConnectionConfig{
		ClientURL: client, DirectURL: direct, SignalURL: signal, ICEURL: ice,
		ClientSecret: strings.Repeat("secret-", 8), HostToken: strings.Repeat("host-", 8), TURNSecret: strings.Repeat("turn-", 8),
	})
	if err := s.remoteControl.SetLANURL(lan); err != nil {
		t.Fatal(err)
	}
	if ticket := s.remoteControl.EnrollmentTicket(signal, "https://other.example/ice?room="+room); ticket != "" {
		t.Fatal("issued a relay capability for a mismatched route")
	}
	updated := code(`{"action":"pair","qrVersion":2,"lan":true}`)
	if approvals != 2 || updated["fingerprint"] != first["fingerprint"] || updated["directUrl"] != direct ||
		updated["lanUrl"] != lan || updated["signalUrl"] != signal || updated["iceUrl"] != ice || updated["relayAuth"] != true || pairingString(updated["relayTicket"]) == "" {
		t.Fatal("one code did not carry all routes and relay capability for the original identity")
	}
	for _, key := range []string{"clientSecret", "hostToken", "turnSecret"} {
		if _, ok := updated[key]; ok {
			t.Fatalf("QR included host-only credential %s", key)
		}
	}
	if err := s.AuthorizeRemoteDevice(context.Background(), "phone-key", key, updated["ticket"].(string)); err != nil {
		t.Fatal(err)
	}
	var count int
	var name, created, storedKey string
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM approved_devices`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("route update duplicated device: %d %v", count, err)
	}
	if err := s.db.QueryRow(`SELECT name,created_at,public_key FROM approved_devices WHERE id='phone-key'`).Scan(&name, &created, &storedKey); err != nil ||
		name != "Personal phone" || created != originalCreated || storedKey != string(key) {
		t.Fatal("route update replaced the device's original identity or custom name", err)
	}
}

func TestPairingRouteRejectsInvalidDirectAndPartialRelay(t *testing.T) {
	for _, connection := range []map[string]any{
		{"directUrl": "ws://host.tail.example/remote-signal"},
		{"directUrl": "wss://user:pass@host.tail.example/remote-signal"},
		{"directUrl": "wss://host.tail.example/remote-signal#credential"},
		{"directUrl": "wss://host.tail.example/remote-signal", "signalUrl": "wss://broker.example/signal"},
		{"directUrl": "wss://host.tail.example/remote-signal", "relayAuth": true},
	} {
		if pairingRouteAvailable(connection) {
			t.Fatal("accepted malformed transport", connection)
		}
	}
}

func TestLANPairingRequiresExplicitNativeQRCodeRequest(t *testing.T) {
	const lan = "wss://192.168.2.9:43124/remote-signal"
	const direct = "wss://host.tail.example/remote-signal"
	var approvals int
	s := deviceTestServer(t, func(context.Context, string) error { approvals++; return nil })
	useDirect := false
	s.devices.bootstrap = func() map[string]any {
		config := map[string]any{"lanUrl": lan, "version": 1, "clientUrl": "https://client.example/"}
		if useDirect {
			config["directUrl"] = direct
		}
		return config
	}
	requestCode := func(body string, status int) string {
		t.Helper()
		r := httptest.NewRequest("POST", "http://localhost/api/devices", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:123"
		w := httptest.NewRecorder()
		s.handleDevices(w, r)
		if w.Code != status {
			t.Fatalf("pair returned %d, want %d: %s", w.Code, status, w.Body)
		}
		if status != 200 {
			return ""
		}
		var out struct{ URL string }
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		qr, err := url.Parse(out.URL)
		if err != nil {
			t.Fatal(err)
		}
		payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(qr.Fragment, "pair="))
		if err != nil {
			t.Fatal(err)
		}
		return string(payload)
	}
	const regular = `{"action":"pair","qrVersion":2}`
	const native = `{"action":"pair","qrVersion":2,"lan":true}`
	requestCode(regular, 409)
	if approvals != 0 {
		t.Fatal("an unavailable browser route prompted for OS authentication")
	}
	if got := requestCode(native, 200); !strings.Contains(got, lan) || approvals != 1 {
		t.Fatal("native LAN request did not require approval and add its endpoint")
	}
	useDirect = true
	if got := requestCode(regular, 200); strings.Contains(got, lan) || !strings.Contains(got, direct) {
		t.Fatal("browser QR leaked LAN or replaced Tailscale")
	}
	if got := requestCode(native, 200); !strings.Contains(got, lan) || !strings.Contains(got, direct) {
		t.Fatal("native QR omitted its LAN or private endpoint")
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

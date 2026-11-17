package relay

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func signRelay(t *testing.T, key *ecdsa.PrivateKey, message string) string {
	t.Helper()
	hash := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...))
}
func securedBroker() *Broker {
	return &Broker{Room: strings.Repeat("r", 32), HostToken: strings.Repeat("h", 64), TURNSecret: strings.Repeat("t", 64), ClientSecret: strings.Repeat("c", 64), PublicIP: "127.0.0.1", Origin: "https://client.example", RequireClientAuth: true}
}
func TestRelayAccessCannotUseIPRoomOrReplayAlone(t *testing.T) {
	b := securedBroker()
	key, pub := testDevice(t)
	_, id, _ := ParsePublicKey(pub)
	b.approved = map[string]bool{id: true}
	header := func(key *ecdsa.PrivateKey, pub json.RawMessage, ticket, nonce string) string {
		stamp := time.Now().Unix()
		p := relayAccessProof{PublicKey: pub, Timestamp: stamp, Nonce: nonce, Ticket: ticket}
		p.Signature = signRelay(t, key, fmt.Sprintf("pi-relay-ice-v1:%s:%d:%s", b.Room, stamp, nonce))
		raw, _ := json.Marshal(p)
		return "PiRelay " + base64.RawURLEncoding.EncodeToString(raw)
	}
	request := func(auth string) int {
		r := httptest.NewRequest("GET", "/ice?room="+b.Room, nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		if w.Code != 200 && strings.Contains(w.Body.String(), "credential") {
			t.Fatal("ICE credentials leaked")
		}
		return w.Code
	}
	if request("") != 401 {
		t.Fatal("IP and room granted TURN access")
	}
	proof := header(key, pub, "", strings.Repeat("a", 32))
	if request(proof) != 200 || request(proof) != 401 {
		t.Fatal("valid proof failed or replay accepted")
	}
	second, secondPub := testDevice(t)
	if request(header(second, secondPub, "", strings.Repeat("b", 32))) != 401 {
		t.Fatal("unknown key accepted")
	}
	ticket := relayTicket(b.ClientSecret, b.Room, strings.Repeat("e", 64), time.Now().Add(3*time.Minute))
	if request(header(second, secondPub, ticket, strings.Repeat("c", 32))) != 200 {
		t.Fatal("fresh relay enrollment rejected")
	}
	third, thirdPub := testDevice(t)
	if request(header(third, thirdPub, ticket, strings.Repeat("d", 32))) != 401 {
		t.Fatal("relay enrollment reused with another key")
	}
	expired := relayTicket(b.ClientSecret, b.Room, strings.Repeat("f", 64), time.Now().Add(-time.Minute))
	if request(header(third, thirdPub, expired, strings.Repeat("f", 32))) != 401 {
		t.Fatal("expired enrollment accepted")
	}
	sig := signRelay(t, key, "pi-relay-client-v1:"+b.Room+":nonce")
	if _, err := VerifyDeviceProof(pub, "nonce", "mac", sig); err == nil {
		t.Fatal("relay proof could approve a Mac device")
	}
}
func TestAuthenticatedHostControlsRelayDeviceRevocation(t *testing.T) {
	b := securedBroker()
	srv := httptest.NewServer(b)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	endpoint := "ws" + strings.TrimPrefix(srv.URL, "http") + "/signal?room=" + b.Room
	host, _, err := websocket.Dial(ctx, endpoint+"&role=host", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + b.HostToken}}})
	if err != nil {
		t.Fatal(err)
	}
	defer host.CloseNow()
	key, pub := testDevice(t)
	_, id, _ := ParsePublicKey(pub)
	if err = wsjson.Write(ctx, host, Signal{Type: "devices", Devices: []string{id}}); err != nil {
		t.Fatal(err)
	}
	for {
		b.mu.Lock()
		ready := b.approved[id]
		b.mu.Unlock()
		if ready {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("whitelist not synchronized")
		case <-time.After(time.Millisecond):
		}
	}
	client, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	var challenge struct{ Type, Nonce string }
	if wsjson.Read(ctx, client, &challenge) != nil || challenge.Type != "relay-challenge" {
		t.Fatal("missing server challenge")
	}
	proof := relayAccessProof{PublicKey: pub, Signature: signRelay(t, key, "pi-relay-client-v1:"+b.Room+":"+challenge.Nonce)}
	if wsjson.Write(ctx, client, proof) != nil {
		t.Fatal("proof send failed")
	}
	var result struct{ Type string }
	if wsjson.Read(ctx, client, &result) != nil || result.Type != "relay-authorized" {
		t.Fatal("approved key rejected")
	}
	if wsjson.Write(ctx, host, Signal{Type: "devices", Devices: []string{}}) != nil {
		t.Fatal("revocation update failed")
	}
	if wsjson.Read(ctx, client, &result) == nil {
		t.Fatal("removed key stayed connected to relay")
	}
	if b.allowDevice(id, "") {
		t.Fatal("removed key can reconnect")
	}
}
func TestRelayVerifyDoesNotExposeSecrets(t *testing.T) {
	b := securedBroker()
	r := httptest.NewRequest("GET", "/verify?room="+url.QueryEscape(b.Room)+"&challenge="+strings.Repeat("a", 64), nil)
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("unauthenticated server configuration")
	}
	r.Header.Set("Authorization", "Bearer "+b.HostToken)
	w = httptest.NewRecorder()
	b.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	for _, secret := range []string{b.HostToken, b.ClientSecret, b.TURNSecret} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("relay secret disclosed")
		}
	}
}

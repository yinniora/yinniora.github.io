package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/webrtc/v4"
)

// Opt-in network smoke test. It uses a temporary Mac identity, test-only
// authorization and fixture data, never the production workspace or whitelist.
func TestVPSRoundTrip(t *testing.T) {
	path := os.Getenv("PI_RELAY_TEST_CONFIG")
	if path == "" {
		t.Skip("set PI_RELAY_TEST_CONFIG for isolated transport smoke test")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct{ IP, Room, HostToken, TurnSecret, Client string }
	if err = json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	endpoint := "wss://" + cfg.IP + ":8443/signal?room=" + cfg.Room
	h, err := NewHost(filepath.Join(t.TempDir(), "test-identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	turn := TURNConfiguration(cfg.IP, cfg.TurnSecret)
	ice := []webrtc.ICEServer{{URLs: turn["urls"].([]string), Username: turn["username"].(string), Credential: turn["credential"]}}
	h.ICE = func() []webrtc.ICEServer { return ice }
	h.Authorize = func(context.Context, string, json.RawMessage, string) error { return nil }
	h.Handler = func(w http.ResponseWriter, r *http.Request, _ string) {
		http.ServeContent(w, r, "fixture.mp4", time.Time{}, strings.NewReader("0123456789"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	go h.ConnectBroker(ctx, endpoint+"&role=host", cfg.HostToken)
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: ice, ICETransportPolicy: webrtc.ICETransportPolicyRelay})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	key, jwk := testDevice(t)
	dc, err := pc.CreateDataChannel("pi-workspace-v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan packet, 20)
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		var v map[string]json.RawMessage
		json.Unmarshal(m.Data, &v)
		var kind string
		json.Unmarshal(v["type"], &kind)
		if kind == "challenge" {
			var nonce string
			json.Unmarshal(v["nonce"], &nonce)
			b, _ := json.Marshal(map[string]any{"type": "auth", "publicKey": jwk, "signature": signProof(t, key, nonce, h.Fingerprint)})
			dc.SendText(string(b))
			return
		}
		if kind == "authorized" {
			b, _ := json.Marshal(packet{Type: "request", ID: "fixture", Method: "GET", Path: "/api/asset?fixture", Headers: http.Header{"Range": {"bytes=2-5"}}})
			dc.SendText(string(b))
			dc.SendText(`{"type":"body-end","id":"fixture"}`)
			return
		}
		var p packet
		json.Unmarshal(m.Data, &p)
		events <- p
	})
	offer, _ := pc.CreateOffer(nil)
	gather := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal("TURN candidate gathering timed out")
	}
	if !strings.Contains(pc.LocalDescription().SDP, " typ relay") {
		t.Fatal("TURN produced no relay candidate")
	}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {cfg.Client}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var answer Signal
	for i := 0; i < 20; i++ {
		if err = wsjson.Write(ctx, conn, Signal{Type: "offer", SDP: pc.LocalDescription().SDP}); err != nil {
			t.Fatal(err)
		}
		if err = wsjson.Read(ctx, conn, &answer); err != nil {
			t.Fatal(err)
		}
		if answer.Type == "answer" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if answer.Type != "answer" || !strings.Contains(strings.ToLower(answer.SDP), h.Fingerprint) {
		t.Fatal("relay did not return pinned Mac answer")
	}
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
	status := 0
	body := ""
	for {
		select {
		case p := <-events:
			switch p.Type {
			case "response":
				status = p.Status
			case "data":
				b, _ := base64.StdEncoding.DecodeString(p.Data)
				body += string(b)
			case "end":
				if status != 206 || body != "2345" {
					t.Fatal(fmt.Sprintf("bad relay Range response %d %q", status, body))
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("encrypted VPS/TURN round trip timed out")
		}
	}
}

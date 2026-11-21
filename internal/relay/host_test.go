package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/webrtc/v4"
)

func TestEncryptedHTTPRequiresDeviceProof(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		t.Run(fmt.Sprint(allowed), func(t *testing.T) {
			host, err := NewHost(filepath.Join(t.TempDir(), "identity.pem"))
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			host.Origins = []string{"client.example"}
			direct := httptest.NewTLSServer(http.HandlerFunc(host.ServeSignal))
			defer direct.Close()
			key, raw := testDevice(t)
			var calls atomic.Int32
			var sawDenial atomic.Bool
			host.Authorize = func(context.Context, string, json.RawMessage, string) error {
				if !allowed {
					return fmt.Errorf("not approved")
				}
				return nil
			}
			host.Handler = func(w http.ResponseWriter, r *http.Request, id string) {
				calls.Add(1)
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("credential forwarded")
				}
				http.ServeContent(w, r, "movie.mp4", time.Time{}, strings.NewReader("0123456789"))
			}
			pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer pc.Close()
			dc, err := pc.CreateDataChannel("pi-workspace-v1", nil)
			if err != nil {
				t.Fatal(err)
			}
			events := make(chan packet, 30)
			closed := make(chan struct{}, 1)
			dc.OnClose(func() {
				select {
				case closed <- struct{}{}:
				default:
				}
			})
			dc.OnMessage(func(m webrtc.DataChannelMessage) {
				var info map[string]json.RawMessage
				json.Unmarshal(m.Data, &info)
				var kind string
				json.Unmarshal(info["type"], &kind)
				if kind == "challenge" {
					var nonce string
					json.Unmarshal(info["nonce"], &nonce)
					proof := map[string]any{"type": "auth", "publicKey": raw, "signature": signProof(t, key, nonce, host.Fingerprint)}
					b, _ := json.Marshal(proof)
					dc.SendText(string(b))
					return
				}
				if kind == "authorized" {
					b, _ := json.Marshal(packet{Type: "request", ID: "media", Method: "GET", Path: "/api/asset?path=movie.mp4", Headers: http.Header{"range": {"bytes=2-5"}, "authorization": {"Bearer stolen"}, "cookie": {"stolen=1"}}})
					dc.SendText(string(b))
					dc.SendText(`{"type":"body-end","id":"media"}`)
					return
				}
				if kind == "denied" {
					sawDenial.Store(true)
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
			<-gather
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			socket, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(direct.URL, "https")+"/remote-signal", &websocket.DialOptions{
				HTTPClient: direct.Client(),
				HTTPHeader: http.Header{"Origin": {"https://client.example"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer socket.CloseNow()
			if err = wsjson.Write(ctx, socket, Signal{Type: "offer", SDP: pc.LocalDescription().SDP}); err != nil {
				t.Fatal(err)
			}
			var answer Signal
			if err = wsjson.Read(ctx, socket, &answer); err != nil {
				t.Fatal(err)
			}
			if answer.Type != "answer" || !strings.Contains(strings.ToLower(answer.SDP), host.Fingerprint) {
				t.Fatal("answer missing pinned identity")
			}
			if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
				t.Fatal(err)
			}
			var status int
			var body strings.Builder
			for {
				select {
				case p := <-events:
					switch p.Type {
					case "denied":
						if allowed {
							t.Fatal("approved device denied")
						}
						if calls.Load() != 0 {
							t.Fatal("unapproved API called")
						}
						return
					case "response":
						status = p.Status
					case "data":
						b, _ := base64.StdEncoding.DecodeString(p.Data)
						body.Write(b)
					case "end":
						if !allowed || status != 206 || body.String() != "2345" || calls.Load() != 1 {
							t.Fatalf("bad encrypted Range: %d %q calls=%d", status, body.String(), calls.Load())
						}
						return
					}
				case <-closed:
					if !allowed && calls.Load() == 0 && sawDenial.Load() {
						return
					}
					t.Fatal("unexpected close")
				case <-ctx.Done():
					t.Fatal("WebRTC timed out")
				}
			}
		})
	}
}
func TestResponseFlowCancellation(t *testing.T) {
	f := &responseFlow{wake: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if f.take(ctx, 16384) == nil {
		t.Fatal("closed request blocked")
	}
	f.add(16384)
	if err := f.take(context.Background(), 16384); err != nil {
		t.Fatal(err)
	}
}

func TestForgedSDPFingerprintCannotImpersonateMac(t *testing.T) {
	pinned, err := NewHost(filepath.Join(t.TempDir(), "real-mac.pem"))
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	fake, err := NewHost(filepath.Join(t.TempDir(), "compromised-relay.pem"))
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	var calls atomic.Int32
	fake.Authorize = func(context.Context, string, json.RawMessage, string) error { calls.Add(1); return nil }
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	opened := make(chan struct{}, 1)
	failed := make(chan struct{}, 1)
	dc, _ := pc.CreateDataChannel("pi-workspace-v1", nil)
	dc.OnOpen(func() { opened <- struct{}{} })
	pc.SCTP().Transport().OnStateChange(func(state webrtc.DTLSTransportState) {
		if state == webrtc.DTLSTransportStateFailed {
			select {
			case failed <- struct{}{}:
			default:
			}
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			select {
			case failed <- struct{}{}:
			default:
			}
		}
	})
	offer, _ := pc.CreateOffer(nil)
	gather := webrtc.GatheringCompletePromise(pc)
	pc.SetLocalDescription(offer)
	<-gather
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	answer, err := fake.Answer(ctx, "fake", pc.LocalDescription().SDP)
	if err != nil {
		t.Fatal(err)
	}
	// A hostile broker can copy the public pin into SDP, but cannot produce a
	// DTLS handshake with the real Mac's private key.
	answer = strings.ReplaceAll(answer, strings.ToUpper(fake.Fingerprint), strings.ToUpper(pinned.Fingerprint))
	answer = strings.ReplaceAll(answer, fake.Fingerprint, pinned.Fingerprint)
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-failed:
		if calls.Load() != 0 {
			t.Fatal("fake Mac reached device authentication")
		}
	case <-opened:
		t.Fatal("forged fingerprint opened a channel")
	case <-ctx.Done():
		t.Fatal("native DTLS did not reject the forged identity in time")
	}
}

func TestHostCandidateFilters(t *testing.T) {
	for name, keep := range map[string]bool{"en0": true, "en1": true, "utun4": true, "awdl0": false, "llw0": false, "bridge100": false, "vmnet8": false, "anpi0": false} {
		if keepInterface(name) != keep {
			t.Fatalf("keepInterface(%q) = %v", name, !keep)
		}
	}
	for ip, keep := range map[string]bool{"192.168.1.5": true, "100.64.1.2": true, "2001:db8::1": true, "127.0.0.1": false, "::1": false, "169.254.1.1": false, "fe80::1": false} {
		if keepCandidateIP(net.ParseIP(ip)) != keep {
			t.Fatalf("keepCandidateIP(%s) = %v", ip, !keep)
		}
	}
}

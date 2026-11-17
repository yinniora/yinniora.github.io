package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/webrtc/v4"
)

type Signal struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	SDP  string `json:"sdp,omitempty"`
}

type Host struct {
	Certificate *webrtc.Certificate
	Fingerprint string
	ICE         func() []webrtc.ICEServer
	Authorize   func(context.Context, string, json.RawMessage, string) error
	WatchDevice func(string, func()) func()
	Handler     func(http.ResponseWriter, *http.Request, string)
	Origins     []string
	peers       sync.Map
	slots       chan struct{}
}

func NewHost(identityFile string) (*Host, error) {
	cert, fingerprint, err := LoadIdentity(identityFile)
	if err != nil {
		return nil, err
	}
	return &Host{Certificate: cert, Fingerprint: fingerprint, slots: make(chan struct{}, 12)}, nil
}

func (h *Host) Answer(ctx context.Context, id, offer string) (string, error) {
	if len(offer) > 64*1024 || !strings.Contains(offer, "a=fingerprint:sha-256 ") {
		return "", errors.New("invalid WebRTC offer")
	}
	select {
	case h.slots <- struct{}{}:
	default:
		return "", errors.New("too many connections")
	}
	configuration := webrtc.Configuration{Certificates: []webrtc.Certificate{*h.Certificate}}
	if h.ICE != nil {
		configuration.ICEServers = h.ICE()
	}
	pc, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		<-h.slots
		return "", err
	}
	h.peers.Store(id, pc)
	var closed sync.Once
	cleanup := func() {
		closed.Do(func() { h.peers.Delete(id); <-h.slots })
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			go pc.Close()
		}
		if state == webrtc.PeerConnectionStateClosed {
			cleanup()
		}
	})
	authenticated := atomic.Bool{}
	channelClaimed := atomic.Bool{}
	timeout := time.AfterFunc(40*time.Second, func() {
		if !authenticated.Load() {
			_ = pc.Close()
		}
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() != "pi-workspace-v1" || !channelClaimed.CompareAndSwap(false, true) {
			_ = channel.Close()
			return
		}
		var rawNonce [32]byte
		if _, err := rand.Read(rawNonce[:]); err != nil {
			_ = pc.Close()
			return
		}
		nonce := base64.RawURLEncoding.EncodeToString(rawNonce[:])
		sessionCtx, cancel := context.WithCancel(context.Background())
		channel.OnClose(cancel)
		writer := newChannelWriter(sessionCtx, channel)
		var bridge *httpBridge
		channel.OnOpen(func() {
			_ = writer.send(map[string]any{"type": "challenge", "nonce": nonce, "fingerprint": h.Fingerprint})
		})
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			if len(message.Data) > 64*1024 {
				_ = pc.Close()
				return
			}
			if authenticated.Load() {
				if bridge != nil {
					bridge.receive(message.Data)
				}
				return
			}
			var proof struct {
				Type, Signature, Ticket string
				PublicKey               json.RawMessage `json:"publicKey"`
			}
			if json.Unmarshal(message.Data, &proof) != nil || proof.Type != "auth" {
				_ = pc.Close()
				return
			}
			deviceID, err := VerifyDeviceProof(proof.PublicKey, nonce, h.Fingerprint, proof.Signature)
			if err == nil && h.Authorize != nil {
				err = h.Authorize(sessionCtx, deviceID, proof.PublicKey, proof.Ticket)
			} else if err == nil {
				err = errors.New("device approval is not configured")
			}
			if err != nil {
				_ = writer.send(map[string]string{"type": "denied", "error": "Device is not approved. Pair again from the Mac."})
				_ = pc.Close()
				return
			}
			bridge = newHTTPBridge(sessionCtx, writer, deviceID, h.Handler)
			authenticated.Store(true)
			timeout.Stop()
			if h.WatchDevice != nil {
				unwatch := h.WatchDevice(deviceID, func() { cancel(); _ = pc.Close() })
				go func() { <-sessionCtx.Done(); unwatch() }()
			}
			_ = writer.send(map[string]string{"type": "authorized", "deviceId": deviceID})
		})
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		_ = pc.Close()
		return "", err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return "", err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return "", err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		_ = pc.Close()
		return "", ctx.Err()
	}
	return pc.LocalDescription().SDP, nil
}

func (h *Host) ClosePeer(id string) {
	if peer, ok := h.peers.Load(id); ok {
		_ = peer.(*webrtc.PeerConnection).Close()
	}
}

func (h *Host) Close() {
	h.peers.Range(func(_, value any) bool { _ = value.(*webrtc.PeerConnection).Close(); return true })
}

func (h *Host) ServeSignal(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.Origins})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(70 * 1024)
	var signal Signal
	if err := wsjson.Read(r.Context(), conn, &signal); err != nil || signal.Type != "offer" {
		return
	}
	var idBytes [16]byte
	_, _ = rand.Read(idBytes[:])
	id := fmt.Sprintf("direct-%x", idBytes[:])
	defer h.ClosePeer(id)
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	answer, err := h.Answer(ctx, id, signal.SDP)
	cancel()
	if err != nil {
		return
	}
	if wsjson.Write(r.Context(), conn, Signal{Type: "answer", SDP: answer}) != nil {
		return
	}
	// Keep signaling alive; data travels directly over DTLS, not this socket.
	for {
		if _, _, err := conn.Read(r.Context()); err != nil {
			return
		}
	}
}

func (h *Host) ConnectBroker(ctx context.Context, endpoint, token string) {
	for ctx.Err() == nil {
		header := http.Header{}
		header.Set("Authorization", "Bearer "+token)
		conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: header})
		if err == nil {
			conn.SetReadLimit(70 * 1024)
			for {
				var signal Signal
				if err := wsjson.Read(ctx, conn, &signal); err != nil {
					break
				}
				if signal.Type == "closed" {
					h.ClosePeer(signal.ID)
				} else if signal.Type == "offer" && len(signal.ID) <= 64 {
					go func(signal Signal) {
						offerCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
						defer cancel()
						answer, err := h.Answer(offerCtx, signal.ID, signal.SDP)
						if err == nil {
							_ = wsjson.Write(ctx, conn, Signal{Type: "answer", ID: signal.ID, SDP: answer})
						}
					}(signal)
				}
			}
			_ = conn.CloseNow()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

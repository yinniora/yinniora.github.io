package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
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
	Type    string   `json:"type"`
	ID      string   `json:"id,omitempty"`
	SDP     string   `json:"sdp,omitempty"`
	Devices []string `json:"devices,omitempty"`
}

type Host struct {
	Certificate  *webrtc.Certificate
	Fingerprint  string
	ICE          func() []webrtc.ICEServer
	Authorize    func(context.Context, string, json.RawMessage, string) error
	WatchDevice  func(string, func()) func()
	Handler      func(http.ResponseWriter, *http.Request, string)
	Origins      []string
	peers        sync.Map
	DeviceIDs    func() []string
	brokerMu     sync.Mutex
	brokerSyncMu sync.Mutex
	brokerConn   *websocket.Conn
	slots        chan struct{}
	api          *webrtc.API
}

// virtualInterfacePrefixes are macOS/host interfaces that never reach a phone:
// AirDrop/peer links, VM and container bridges, and legacy tunnels. Tailscale
// (utunN) and normal LAN interfaces stay available.
var virtualInterfacePrefixes = []string{"awdl", "llw", "anpi", "bridge", "vmnet", "vboxnet", "docker", "veth", "gif", "stf"}

func keepInterface(name string) bool {
	for _, prefix := range virtualInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}

func keepCandidateIP(ip net.IP) bool {
	return !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified()
}

// newHostAPI trims host candidates so answers are smaller and connectivity
// checks do not spend their budget on interfaces the phone cannot reach.
func newHostAPI() *webrtc.API {
	settings := webrtc.SettingEngine{}
	settings.SetInterfaceFilter(keepInterface)
	settings.SetIPFilter(keepCandidateIP)
	return webrtc.NewAPI(webrtc.WithSettingEngine(settings))
}

func NewHost(identityFile string) (*Host, error) {
	cert, fingerprint, err := LoadIdentity(identityFile)
	if err != nil {
		return nil, err
	}
	return &Host{Certificate: cert, Fingerprint: fingerprint, slots: make(chan struct{}, 12), api: newHostAPI()}, nil
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
	newPeer := webrtc.NewPeerConnection
	if h.api != nil {
		newPeer = h.api.NewPeerConnection
	}
	pc, err := newPeer(configuration)
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
	rejected := atomic.Bool{}
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
			if rejected.Load() {
				return
			}
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
				rejected.Store(true)
				_ = writer.send(map[string]string{"type": "denied", "error": "Device is not approved. Pair again from the Mac."})
				// Allow the denial frame to leave SCTP before tearing down DTLS.
				time.AfterFunc(250*time.Millisecond, func() { _ = pc.Close() })
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
	relayReady := make(chan struct{}, 1)
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil && candidate.Typ == webrtc.ICECandidateTypeRelay {
			select {
			case relayReady <- struct{}{}:
			default:
			}
		}
	})
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return "", err
	}
	select {
	case <-gathered:
	case <-relayReady:
		// Give the other transports a short chance to appear without holding
		// the answer for an unreachable network interface.
		grace := time.NewTimer(400 * time.Millisecond)
		defer grace.Stop()
		select {
		case <-gathered:
		case <-grace.C:
		case <-ctx.Done():
			_ = pc.Close()
			return "", ctx.Err()
		}
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
	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
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
			h.brokerMu.Lock()
			h.brokerConn = conn
			h.brokerMu.Unlock()
			h.SyncDevices()
			keepCtx, stopKeepAlive := context.WithCancel(ctx)
			go h.keepBrokerAlive(keepCtx, conn, 20*time.Second, 8*time.Second)
			for {
				var signal Signal
				if err := wsjson.Read(ctx, conn, &signal); err != nil {
					break
				}
				if signal.Type == "closed" {
					h.ClosePeer(signal.ID)
				} else if signal.Type == "offer" && len(signal.ID) <= 64 {
					go func(signal Signal) {
						offerCtx, cancel := context.WithTimeout(ctx, 18*time.Second)
						defer cancel()
						answer, err := h.Answer(offerCtx, signal.ID, signal.SDP)
						if err == nil {
							_ = wsjson.Write(ctx, conn, Signal{Type: "answer", ID: signal.ID, SDP: answer})
						}
					}(signal)
				}
			}
			stopKeepAlive()
			_ = conn.CloseNow()
			h.brokerMu.Lock()
			if h.brokerConn == conn {
				h.brokerConn = nil
			}
			h.brokerMu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (h *Host) SyncDevices() {
	h.brokerSyncMu.Lock()
	defer h.brokerSyncMu.Unlock()
	if h.DeviceIDs == nil {
		return
	}
	devices := h.DeviceIDs()
	h.brokerMu.Lock()
	conn := h.brokerConn
	h.brokerMu.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if wsjson.Write(ctx, conn, Signal{Type: "devices", Devices: devices}) != nil {
		_ = conn.CloseNow()
	}
}

func (h *Host) keepBrokerAlive(ctx context.Context, conn *websocket.Conn, interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, timeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = conn.CloseNow()
				return
			}
			h.SyncDevices()
		}
	}
}

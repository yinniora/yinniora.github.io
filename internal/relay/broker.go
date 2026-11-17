package relay

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type Broker struct {
	Room, HostToken, TURNSecret, PublicIP, Origin string
	ClientSecret                                  string
	RequireClientAuth                             bool
	approved                                      map[string]bool
	clientDevices                                 map[string]string
	enrollments                                   map[string]relayEnrollment
	replays                                       map[string]int64
	rates                                         map[string]relayRate
	pending                                       int
	mu                                            sync.Mutex
	host                                          *websocket.Conn
	clients                                       map[string]*websocket.Conn
}

func TURNConfiguration(ip, secret string) map[string]any {
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	username := fmt.Sprintf("%d:pi-%s", time.Now().Add(2*time.Hour).Unix(), hex.EncodeToString(nonce[:]))
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return map[string]any{"urls": []string{"turn:" + net.JoinHostPort(ip, "3478") + "?transport=udp", "turn:" + net.JoinHostPort(ip, "3478") + "?transport=tcp"},
		"username": username, "credential": base64.StdEncoding.EncodeToString(mac.Sum(nil))}
}

func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if parsed := net.ParseIP(ip); parsed != nil && parsed.IsLoopback() {
		forwarded := r.Header.Get("X-Forwarded-For")
		if address := net.ParseIP(forwarded); address != nil {
			ip = address.String()
		}
	}
	if !b.admit(ip) {
		http.Error(w, "rate limited", 429)
		return
	}
	if r.URL.Query().Get("room") != b.Room || len(b.Room) < 20 {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/verify" {
		if r.Method != "GET" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+b.HostToken)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		challenge := r.URL.Query().Get("challenge")
		if len(challenge) != 64 {
			http.Error(w, "invalid challenge", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		b.mu.Lock()
		hostConnected := b.host != nil
		approvedDevices := len(b.approved)
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"protocol": "pi-relay-v2", "turnHost": b.PublicIP, "clientOrigin": b.Origin, "proof": RelayProof(b.TURNSecret, "turn:"+challenge), "clientProof": RelayProof(b.ClientSecret, "client:"+challenge), "requiresClientAuth": b.RequireClientAuth, "hostConnected": hostConnected, "approvedDevices": approvedDevices})
		return
	}
	if r.URL.Path == "/ice" {
		if r.Header.Get("Origin") == b.Origin {
			w.Header().Set("Access-Control-Allow-Origin", b.Origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == "OPTIONS" && r.Header.Get("Origin") == b.Origin {
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization")
			w.WriteHeader(204)
			return
		}
		if r.Method != "GET" || !b.verifyICE(r.Header.Get("Authorization")) {
			http.Error(w, "relay authentication required", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"iceServers": []any{TURNConfiguration(b.PublicIP, b.TURNSecret)}})
		return
	}
	if r.URL.Path != "/signal" {
		http.NotFound(w, r)
		return
	}
	isHost := r.URL.Query().Get("role") == "host"
	if isHost && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+b.HostToken)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	originHost := strings.TrimPrefix(strings.TrimPrefix(b.Origin, "https://"), "http://")
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{originHost}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(70 * 1024)
	b.mu.Lock()
	if b.clients == nil {
		b.clients = make(map[string]*websocket.Conn)
	}
	if isHost {
		conn.SetReadLimit(256 * 1024)
		old := b.host
		b.host = conn
		b.mu.Unlock()
		if old != nil {
			_ = old.CloseNow()
		}
		defer func() {
			b.mu.Lock()
			if b.host == conn {
				b.host = nil
			}
			b.mu.Unlock()
		}()
		for {
			var message Signal
			if wsjson.Read(r.Context(), conn, &message) != nil {
				return
			}
			if message.Type == "devices" && len(message.Devices) <= 2048 {
				b.mu.Lock()
				if b.host != conn {
					b.mu.Unlock()
					return
				}
				previous := b.approved
				b.approved = map[string]bool{}
				for _, id := range message.Devices {
					if len(id) == 64 {
						b.approved[id] = true
					}
				}
				var removed []*websocket.Conn
				for id, device := range b.clientDevices {
					if device != "" && !b.approved[device] {
						pending := false
						if !previous[device] {
							for _, entry := range b.enrollments {
								if entry.id == device && entry.expires >= time.Now().Unix() {
									pending = true
									break
								}
							}
						}
						if !pending {
							removed = append(removed, b.clients[id])
						}
					}
				}
				b.mu.Unlock()
				for _, client := range removed {
					if client != nil {
						_ = client.CloseNow()
					}
				}
				continue
			}
			if message.Type != "answer" || len(message.SDP) > 64*1024 {
				continue
			}
			b.mu.Lock()
			target := b.clients[message.ID]
			b.mu.Unlock()
			if target != nil {
				_ = wsjson.Write(r.Context(), target, message)
			}
		}
	}
	if b.pending >= 32 {
		b.mu.Unlock()
		return
	}
	b.pending++
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.pending--; b.mu.Unlock() }()
	var deviceID string
	if b.RequireClientAuth || b.ClientSecret != "" {
		var nonce [32]byte
		_, _ = rand.Read(nonce[:])
		challenge := hex.EncodeToString(nonce[:])
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if wsjson.Write(ctx, conn, map[string]string{"type": "relay-challenge", "nonce": challenge}) != nil {
			return
		}
		var proof relayAccessProof
		if wsjson.Read(ctx, conn, &proof) != nil {
			return
		}
		var err error
		deviceID, err = verifyRelaySignature(proof, "pi-relay-client-v1:"+b.Room+":"+challenge)
		if err != nil || !b.allowDevice(deviceID, proof.Ticket) {
			_ = conn.Close(websocket.StatusPolicyViolation, "relay authentication required")
			return
		}
		if wsjson.Write(ctx, conn, map[string]string{"type": "relay-authorized"}) != nil {
			return
		}
	}
	b.mu.Lock()
	if len(b.clients) >= 32 {
		b.mu.Unlock()
		return
	}
	var randomID [16]byte
	_, _ = rand.Read(randomID[:])
	id := hex.EncodeToString(randomID[:])
	b.clients[id] = conn
	if b.clientDevices == nil {
		b.clientDevices = map[string]string{}
	}
	b.clientDevices[id] = deviceID
	b.mu.Unlock()
	// A QR permits only a short enrollment window, not an indefinite server login.
	enrollmentTimer := time.AfterFunc(3*time.Minute, func() {
		b.mu.Lock()
		approved := b.approved[deviceID]
		b.mu.Unlock()
		if deviceID != "" && !approved {
			_ = conn.CloseNow()
		}
	})
	defer enrollmentTimer.Stop()
	defer func() {
		b.mu.Lock()
		delete(b.clients, id)
		delete(b.clientDevices, id)
		host := b.host
		b.mu.Unlock()
		if host != nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = wsjson.Write(ctx, host, Signal{Type: "closed", ID: id})
		}
	}()
	for {
		var message Signal
		if wsjson.Read(r.Context(), conn, &message) != nil {
			return
		}
		if message.Type != "offer" || len(message.SDP) > 64*1024 {
			return
		}
		message.ID = id
		b.mu.Lock()
		host := b.host
		b.mu.Unlock()
		if host == nil {
			_ = wsjson.Write(r.Context(), conn, Signal{Type: "offline"})
			continue
		}
		_ = wsjson.Write(r.Context(), host, message)
	}
}

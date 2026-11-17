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
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type Broker struct {
	Room, HostToken, TURNSecret, PublicIP, Origin string
	mu                                            sync.Mutex
	host                                          *websocket.Conn
	clients                                       map[string]*websocket.Conn
}

func TURNConfiguration(ip, secret string) map[string]any {
	username := fmt.Sprintf("%d:pi", time.Now().Add(2*time.Hour).Unix())
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return map[string]any{"urls": []string{"turn:" + ip + ":3478?transport=udp", "turn:" + ip + ":3478?transport=tcp"},
		"username": username, "credential": base64.StdEncoding.EncodeToString(mac.Sum(nil))}
}

func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("room") != b.Room || len(b.Room) < 20 {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/ice" {
		if r.Header.Get("Origin") == b.Origin {
			w.Header().Set("Access-Control-Allow-Origin", b.Origin)
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
	if len(b.clients) >= 32 {
		b.mu.Unlock()
		return
	}
	var randomID [16]byte
	_, _ = rand.Read(randomID[:])
	id := hex.EncodeToString(randomID[:])
	b.clients[id] = conn
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.clients, id)
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

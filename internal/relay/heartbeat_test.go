package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestBrokerHeartbeatResendsEmptyAuthoritativeWhitelist(t *testing.T) {
	packets := make(chan Signal, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			var message Signal
			if wsjson.Read(r.Context(), conn, &message) != nil {
				return
			}
			packets <- message
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	h := &Host{brokerConn: conn, DeviceIDs: func() []string { return []string{} }}
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()
	go h.keepBrokerAlive(ctx, conn, 15*time.Millisecond, time.Second)
	select {
	case message := <-packets:
		if message.Type != "devices" || len(message.Devices) != 0 {
			t.Fatal("empty revocation state was not synchronized")
		}
	case <-ctx.Done():
		t.Fatal("heartbeat did not resynchronize the whitelist")
	}
}

func TestBrokerHeartbeatClosesAHalfOpenSocket(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		<-release
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	h := &Host{brokerConn: conn}
	done := make(chan struct{})
	go func() { h.keepBrokerAlive(ctx, conn, 10*time.Millisecond, 60*time.Millisecond); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("half-open broker connection did not close")
	}
	if conn.Write(context.Background(), websocket.MessageText, []byte("probe")) == nil {
		t.Fatal("stale connection remained usable")
	}
}

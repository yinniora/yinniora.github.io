package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"pi-web/internal/auth"
)

const deviceSchema = `CREATE TABLE IF NOT EXISTS approved_devices (
 id TEXT PRIMARY KEY, public_key TEXT NOT NULL, name TEXT NOT NULL,
 created_at TEXT NOT NULL, last_seen TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT ''
)`

type deviceTicket struct {
	name    string
	expires time.Time
}
type deviceAccess struct {
	db         *sql.DB
	approve    func(context.Context, string) error
	bootstrap  func() map[string]any
	mu         sync.Mutex
	approvalMu sync.Mutex
	tickets    map[string]deviceTicket
	active     map[string]map[string]func()
	now        func() time.Time
}

func (s *Server) AuthorizeRemoteDevice(ctx context.Context, id string, publicKey json.RawMessage, ticket string) error {
	if s.devices == nil {
		return fmt.Errorf("device authentication is disabled")
	}
	return s.devices.authorize(ctx, id, publicKey, ticket)
}
func (s *Server) WatchRemoteDevice(id string, closePeer func()) func() {
	if s.devices == nil {
		closePeer()
		return func() {}
	}
	return s.devices.watch(id, closePeer)
}

func newDeviceAccess(db *sql.DB, approve func(context.Context, string) error) (*deviceAccess, error) {
	if _, err := db.Exec(deviceSchema); err != nil {
		return nil, err
	}
	return &deviceAccess{db: db, approve: approve, tickets: make(map[string]deviceTicket), active: make(map[string]map[string]func()), now: time.Now}, nil
}
func randomDeviceSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func hashDeviceSecret(secret string) string {
	hash := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(hash[:])
}

func localDeviceAdmin(r *http.Request) bool {
	if auth.ApprovedDeviceID(r) != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	target := r.Host
	if h, _, err := net.SplitHostPort(target); err == nil {
		target = h
	}
	targetIP := net.ParseIP(target)
	return ip != nil && ip.IsLoopback() && (target == "localhost" || (targetIP != nil && targetIP.IsLoopback()))
}

// Neither VPS forwarding headers, Tailscale membership nor an old shared token
// authenticates a remote device. Remote HTTP is signaling only; application
// requests enter through a fingerprint-pinned, device-authenticated DTLS channel.
func (s *Server) WrapDevices(next http.Handler, forcedRemote bool) http.Handler {
	if s.devices == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth.ApprovedDeviceID(r) != "" || (!forcedRemote && localDeviceAdmin(r)) || r.URL.Path == "/remote-signal" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !strings.Contains(r.Header.Get("Accept"), "text/html") {
			writeJSONError(w, 401, "Device approval required. Pair from the Mac.")
			return
		}
		if s.devices.bootstrap != nil {
			if destination, ok := s.devices.bootstrap()["clientUrl"].(string); ok {
				if u, err := url.Parse(destination); err == nil && u.Scheme == "https" && u.Host != "" {
					http.Redirect(w, r, destination, http.StatusSeeOther)
					return
				}
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
		w.WriteHeader(401)
		fmt.Fprint(w, `<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi · 设备认证</title><style>body{font:16px/1.8 system-ui;background:#fafafa;color:#242424;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:350px;padding:32px}h1{font-size:26px}p{color:#737373}</style><main><h1>Pi 私人工作区</h1><p>请在 Mac 打开 Pi Chat → 设备，完成 Mac 系统认证后，扫描一次性二维码。</p><p>VPS 和 Tailscale 仅提供连接，设备认证由 Mac 独立验证。</p></main></html>`)
	})
}

func (d *deviceAccess) authorize(ctx context.Context, id string, publicKey json.RawMessage, ticket string) error {
	var revoked string
	err := d.db.QueryRowContext(ctx, `SELECT revoked_at FROM approved_devices WHERE id=?`, id).Scan(&revoked)
	if ticket == "" {
		if err != nil || revoked != "" {
			return fmt.Errorf("device is not approved")
		}
		_, err = d.db.ExecContext(ctx, `UPDATE approved_devices SET last_seen=? WHERE id=?`, d.now().UTC().Format(time.RFC3339Nano), id)
		return err
	}
	d.mu.Lock()
	pending, ok := d.tickets[hashDeviceSecret(ticket)]
	if ok {
		delete(d.tickets, hashDeviceSecret(ticket))
	}
	d.mu.Unlock()
	if !ok || !d.now().Before(pending.expires) {
		return fmt.Errorf("pairing code expired")
	}
	stamp := d.now().UTC().Format(time.RFC3339Nano)
	_, err = d.db.ExecContext(ctx, `INSERT INTO approved_devices(id,public_key,name,created_at,last_seen) VALUES(?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen,revoked_at=''`, id, string(publicKey), pending.name, stamp, stamp)
	return err
}

func (d *deviceAccess) watch(id string, closePeer func()) func() {
	key, _ := randomDeviceSecret()
	d.mu.Lock()
	var active int
	err := d.db.QueryRow(`SELECT 1 FROM approved_devices WHERE id=? AND revoked_at=''`, id).Scan(&active)
	if err != nil {
		d.mu.Unlock()
		closePeer()
		return func() {}
	}
	if d.active[id] == nil {
		d.active[id] = make(map[string]func())
	}
	d.active[id][key] = closePeer
	d.mu.Unlock()
	return func() { d.mu.Lock(); delete(d.active[id], key); d.mu.Unlock() }
}
func (d *deviceAccess) revoke(id string) error {
	if _, err := d.db.Exec(`UPDATE approved_devices SET revoked_at=? WHERE id=?`, d.now().UTC().Format(time.RFC3339Nano), id); err != nil {
		return err
	}
	d.mu.Lock()
	closers := d.active[id]
	delete(d.active, id)
	d.mu.Unlock()
	for _, closePeer := range closers {
		closePeer()
	}
	return nil
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	if s.devices == nil {
		writeJSON(w, 200, map[string]any{"enabled": false, "canManage": false, "devices": []any{}})
		return
	}
	d := s.devices
	admin := localDeviceAdmin(r)
	if r.Method == http.MethodGet {
		out := []map[string]string{}
		if admin {
			rows, err := d.db.Query(`SELECT id,name,created_at,last_seen,revoked_at FROM approved_devices ORDER BY created_at DESC`)
			if err != nil {
				writeJSONError(w, 500, "cannot read device whitelist")
				return
			}
			defer rows.Close()
			for rows.Next() {
				var id, name, created, seen, revoked string
				if rows.Scan(&id, &name, &created, &seen, &revoked) == nil {
					out = append(out, map[string]string{"id": id, "name": name, "createdAt": created, "lastSeen": seen, "revokedAt": revoked})
				}
			}
		}
		writeJSON(w, 200, map[string]any{"enabled": true, "canManage": admin, "devices": out, "currentDevice": auth.ApprovedDeviceID(r)})
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	if !admin {
		writeJSONError(w, 403, "Device approval is available only on the Mac itself.")
		return
	}
	var body struct{ Action, Name, ID string }
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Action == "revoke" {
		if d.revoke(body.ID) != nil {
			writeJSONError(w, 500, "cannot revoke device")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if body.Action != "pair" || len(body.Name) > 100 {
		writeJSONError(w, 400, "invalid device request")
		return
	}
	if d.approve == nil || d.bootstrap == nil {
		writeJSONError(w, 403, "Mac system authentication is not configured; no pairing code was created.")
		return
	}
	if !d.approvalMu.TryLock() {
		writeJSONError(w, 409, "A Mac authentication request is already open.")
		return
	}
	defer d.approvalMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if d.approve(ctx, strings.TrimSpace(body.Name)) != nil {
		writeJSONError(w, 403, "Mac system authentication was not completed; no pairing code was created.")
		return
	}
	metadata := d.bootstrap()
	metadata["locale"] = s.getSetting("pi-web:v1:locale", "en")
	clientURL, _ := metadata["clientUrl"].(string)
	client, err := url.Parse(clientURL)
	if err != nil || client.Scheme != "https" || client.Host == "" {
		writeJSONError(w, 503, "trusted client is not configured")
		return
	}
	secret, err := randomDeviceSecret()
	if err != nil {
		writeJSONError(w, 500, "cannot create pairing code")
		return
	}
	expires := d.now().Add(3 * time.Minute)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "iPhone"
	}
	d.mu.Lock()
	for key, pair := range d.tickets {
		if !d.now().Before(pair.expires) {
			delete(d.tickets, key)
		}
	}
	if len(d.tickets) >= 32 {
		d.mu.Unlock()
		writeJSONError(w, 429, "too many pending codes")
		return
	}
	d.tickets[hashDeviceSecret(secret)] = deviceTicket{name: name, expires: expires}
	d.mu.Unlock()
	metadata["ticket"] = secret
	data, _ := json.Marshal(metadata)
	client.Fragment = "pair=" + base64.RawURLEncoding.EncodeToString(data)
	writeJSON(w, 200, map[string]any{"url": client.String(), "expiresAt": expires})
}

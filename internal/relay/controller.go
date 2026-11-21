package relay

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const DefaultClientURL = "https://yinniora.github.io/"

var errPrivateFile = errors.New("remote configuration must be a private regular file owned by the current user")

type ConnectionConfig struct{ ClientURL, SignalURL, ICEURL, DirectURL, HostToken, TURNHost, TURNSecret, ClientSecret string }
type ServerProfile struct {
	ServerURL    string `json:"serverUrl"`
	Room         string `json:"room"`
	HostToken    string `json:"hostToken,omitempty"`
	TURNSecret   string `json:"turnSecret,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
}
type directProfile struct {
	DirectURL string `json:"directUrl"`
}

type Controller struct {
	mu                  sync.Mutex
	host                *Host
	filename            string
	config              ConnectionConfig
	ctx                 context.Context
	cancel              context.CancelFunc
	client              *http.Client
	trustedClientOrigin string
	lanURL              string
}

func NewController(host *Host, filename string, baseline ConnectionConfig) (*Controller, error) {
	if baseline.ClientURL == "" {
		baseline.ClientURL = DefaultClientURL
	}
	clientURL, err := url.Parse(baseline.ClientURL)
	if err != nil || clientURL.Scheme != "https" || clientURL.Host == "" || clientURL.User != nil || (clientURL.Path != "" && clientURL.Path != "/") || clientURL.RawQuery != "" || clientURL.Fragment != "" {
		return nil, errors.New("trusted client must use an independent HTTPS origin")
	}
	c := &Controller{host: host, filename: filename, config: baseline, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	c.trustedClientOrigin = clientURL.Scheme + "://" + clientURL.Host
	if raw, err := readPrivateFile(filename); err == nil {
		var profile ServerProfile
		if json.Unmarshal(raw, &profile) != nil {
			return nil, errors.New("invalid remote configuration")
		}
		if err = c.validate(profile); err != nil {
			return nil, err
		}
		c.config = c.configuration(profile)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	directFile := c.directProfilePath()
	if raw, err := readPrivateFile(directFile); err == nil {
		var profile directProfile
		if err = json.Unmarshal(raw, &profile); err != nil {
			return nil, errors.New("invalid direct signaling configuration")
		}
		c.config.DirectURL = profile.DirectURL
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if c.config.DirectURL != "" && !ValidDirectSignalingURL(c.config.DirectURL) {
		return nil, errors.New("invalid direct signaling URL")
	}
	host.ICE = c.iceServers
	return c, nil
}

func ValidDirectSignalingURL(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && u.Scheme == "wss" && u.Hostname() != "" && u.User == nil && u.Fragment == ""
}

func (c *Controller) directProfilePath() string {
	return filepath.Join(filepath.Dir(c.filename), "direct.json")
}

func (c *Controller) DirectURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config.DirectURL
}

// SetDirectURL changes only the private signaling route, preserving relay credentials.
func (c *Controller) SetDirectURL(endpoint string) error {
	if endpoint != "" && !ValidDirectSignalingURL(endpoint) {
		return errors.New("invalid direct signaling URL")
	}
	raw, _ := json.Marshal(directProfile{DirectURL: endpoint})
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := writePrivateProfile(c.directProfilePath(), raw); err != nil {
		return err
	}
	c.config.DirectURL = endpoint
	return nil
}

// SetLANURL advertises an active LAN listener. It is cleared on restart until
// the host reinstates its listener and publishes the current address.
func (c *Controller) SetLANURL(endpoint string) error {
	if endpoint != "" && !ValidLANSignalingURL(endpoint) {
		return errors.New("invalid LAN signaling URL")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lanURL = endpoint
	return nil
}
func (c *Controller) configuration(p ServerProfile) ConnectionConfig {
	next := c.config
	u, _ := url.Parse(p.ServerURL)
	q := url.Values{"room": []string{p.Room}}
	signal := *u
	signal.Scheme = "wss"
	signal.Path = "/signal"
	signal.RawQuery = q.Encode()
	ice := *u
	ice.Path = "/ice"
	ice.RawQuery = q.Encode()
	next.SignalURL, next.ICEURL, next.HostToken, next.TURNHost, next.TURNSecret, next.ClientSecret = signal.String(), ice.String(), p.HostToken, u.Hostname(), p.TURNSecret, p.ClientSecret
	return next
}
func (c *Controller) profile() ServerProfile {
	u, err := url.Parse(c.config.SignalURL)
	if err != nil || u.Host == "" {
		return ServerProfile{}
	}
	room := u.Query().Get("room")
	u.Scheme = "https"
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return ServerProfile{ServerURL: strings.TrimRight(u.String(), "/"), Room: room, HostToken: c.config.HostToken, TURNSecret: c.config.TURNSecret, ClientSecret: c.config.ClientSecret}
}
func (c *Controller) validate(p ServerProfile) error {
	u, err := url.Parse(p.ServerURL)
	if err != nil || len(p.ServerURL) > 300 || u.Scheme != "https" || u.Hostname() == "" || len(u.Hostname()) > 253 || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("enter an HTTPS server origin without a path or credentials")
	}
	if len(p.Room) < 20 || len(p.Room) > 128 || strings.ContainsAny(p.Room, " \r\n\t") {
		return errors.New("routing ID must contain 20–128 characters")
	}
	if strings.EqualFold(u.Scheme+"://"+u.Host, c.trustedClientOrigin) {
		return errors.New("the trusted client must not be hosted by the relay")
	}
	for _, secret := range []string{p.HostToken, p.TURNSecret, p.ClientSecret} {
		if len(secret) < 32 || len(secret) > 512 || strings.ContainsAny(secret, "\r\n\x00") {
			return errors.New("relay credentials must contain 32–512 characters")
		}
	}
	return nil
}
func RelayProof(secret, challenge string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("pi-relay-config-v1:" + challenge))
	return hex.EncodeToString(mac.Sum(nil))
}
func (c *Controller) prepare(p ServerProfile) (ServerProfile, error) {
	p.ServerURL = strings.TrimRight(strings.TrimSpace(p.ServerURL), "/")
	p.Room = strings.TrimSpace(p.Room)
	c.mu.Lock()
	old := c.profile()
	c.mu.Unlock()
	// Blank fields never copy an existing credential to a different server/room.
	if p.ServerURL == old.ServerURL && p.Room == old.Room {
		if p.HostToken == "" {
			p.HostToken = old.HostToken
		}
		if p.TURNSecret == "" {
			p.TURNSecret = old.TURNSecret
		}
		if p.ClientSecret == "" {
			p.ClientSecret = old.ClientSecret
		}
	}
	return p, c.validate(p)
}
func (c *Controller) Validate(p ServerProfile) error { _, err := c.prepare(p); return err }
func (c *Controller) Save(ctx context.Context, p ServerProfile) error {
	var err error
	p, err = c.prepare(p)
	if err != nil {
		return err
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	challenge := hex.EncodeToString(nonce[:])
	u, _ := url.Parse(p.ServerURL)
	u.Path = "/verify"
	u.RawQuery = url.Values{"room": []string{p.Room}, "challenge": []string{challenge}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.HostToken)
	resp, err := c.client.Do(req)
	if err != nil {
		return errors.New("cannot verify relay HTTPS connection")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("relay authentication failed or this server needs the current pi-relay version")
	}
	var verified struct {
		Protocol, TURNHost, ClientOrigin, Proof, ClientProof string
		RequiresClientAuth                                   bool
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&verified) != nil {
		return errors.New("invalid relay verification response")
	}
	origin := c.trustedClientOrigin
	if verified.Protocol != "pi-relay-v2" || !verified.RequiresClientAuth || verified.TURNHost != u.Hostname() || strings.TrimRight(verified.ClientOrigin, "/") != origin || subtle.ConstantTimeCompare([]byte(verified.Proof), []byte(RelayProof(p.TURNSecret, "turn:"+challenge))) != 1 || subtle.ConstantTimeCompare([]byte(verified.ClientProof), []byte(RelayProof(p.ClientSecret, "client:"+challenge))) != 1 {
		return errors.New("relay authentication, origin or credential verification failed")
	}
	raw, _ := json.Marshal(p)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err = writePrivateProfile(c.filename, raw); err != nil {
		return err
	}
	c.config = c.configuration(p)
	c.restartLocked()
	return nil
}

func writePrivateProfile(filename string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(filename), ".connection-"+hex.EncodeToString(nonce[:]))
	file, err := createPrivateFile(temp)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
func (c *Controller) Bootstrap() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	v := c.config
	return map[string]any{"version": 1, "fingerprint": c.host.Fingerprint, "clientUrl": v.ClientURL, "signalUrl": v.SignalURL, "iceUrl": v.ICEURL, "directUrl": v.DirectURL, "lanUrl": c.lanURL, "relayAuth": v.ClientSecret != ""}
}
func (c *Controller) PublicSettings() map[string]any {
	c.mu.Lock()
	p := c.profile()
	directConfigured := ValidDirectSignalingURL(c.config.DirectURL)
	lanConfigured := c.lanURL != ""
	c.mu.Unlock()
	detected := false
	if addresses, err := net.InterfaceAddrs(); err == nil {
		for _, addr := range addresses {
			ip, _, err := net.ParseCIDR(addr.String())
			if err == nil {
				v := ip.To4()
				if (v != nil && v[0] == 100 && v[1] >= 64 && v[1] <= 127) || strings.HasPrefix(strings.ToLower(ip.String()), "fd7a:115c:a1e0:") {
					detected = true
					break
				}
			}
		}
	}
	return map[string]any{"serverUrl": p.ServerURL, "room": p.Room, "hasHostToken": p.HostToken != "", "hasTurnSecret": p.TURNSecret != "", "hasClientSecret": p.ClientSecret != "", "privateNetworkDetected": detected, "directConfigured": directConfigured, "lanConfigured": lanConfigured, "p2p": true}
}
func (c *Controller) Start(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ctx = ctx
	c.restartLocked()
}
func (c *Controller) restartLocked() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.ctx == nil || c.config.SignalURL == "" {
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.cancel = cancel
	u, err := url.Parse(c.config.SignalURL)
	if err != nil {
		return
	}
	q := u.Query()
	q.Set("role", "host")
	u.RawQuery = q.Encode()
	go c.host.ConnectBroker(ctx, u.String(), c.config.HostToken)
}
func (c *Controller) iceServers() []webrtc.ICEServer {
	c.mu.Lock()
	v := c.config
	c.mu.Unlock()
	if v.TURNHost == "" || v.TURNSecret == "" {
		return nil
	}
	config := TURNConfiguration(v.TURNHost, v.TURNSecret)
	return []webrtc.ICEServer{{URLs: config["urls"].([]string), Username: config["username"].(string), Credential: config["credential"]}}
}
func (c *Controller) SyncDevices() { go c.host.SyncDevices() }
func (c *Controller) EnrollmentTicket(signalURL, iceURL string) string {
	c.mu.Lock()
	config := c.config
	c.mu.Unlock()
	if config.ClientSecret == "" || config.SignalURL != signalURL || config.ICEURL != iceURL {
		return ""
	}
	u, err := url.Parse(signalURL)
	if err != nil || u.Host == "" {
		return ""
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return ""
	}
	return relayTicket(config.ClientSecret, u.Query().Get("room"), hex.EncodeToString(nonce[:]), time.Now().Add(3*time.Minute))
}

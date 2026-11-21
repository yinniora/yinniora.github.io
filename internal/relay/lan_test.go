package relay

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
)

func TestLANSignalingUsesOnlyPrivateIPv4(t *testing.T) {
	for _, endpoint := range []string{
		"wss://10.49.8.2:43821/remote-signal",
		"wss://172.31.0.1:43821/remote-signal",
		"wss://192.168.2.9:43821/remote-signal",
	} {
		if !ValidLANSignalingURL(endpoint) {
			t.Fatalf("rejected private LAN endpoint %s", endpoint)
		}
	}
	for _, endpoint := range []string{
		"ws://192.168.2.9:43821/remote-signal",
		"wss://127.0.0.1:43821/remote-signal",
		"wss://100.80.2.3:43821/remote-signal",
		"wss://172.32.0.1:43821/remote-signal",
		"wss://[fd00::1]:43821/remote-signal",
		"wss://192.168.2.9/remote-signal",
		"wss://192.168.2.9:43821/remote-signal?token=1",
		"wss://user@192.168.2.9:43821/remote-signal",
		"wss://192.168.2.9:43821/api/version",
	} {
		if ValidLANSignalingURL(endpoint) {
			t.Fatalf("accepted unsafe LAN endpoint %s", endpoint)
		}
	}
	for _, bind := range []string{"127.0.0.1:0", "0.0.0.0:0", "100.80.2.3:0", "[fd00::1]:0"} {
		if _, err := ListenLAN(nil, bind); err == nil {
			t.Fatalf("accepted unsafe LAN bind %s", bind)
		}
	}
}

func TestLANLeafMatchesTheHostDevicePin(t *testing.T) {
	host, err := NewHost(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	config, err := lanTLSConfig(host)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(config.Certificates[0].Certificate[0])
	if pin := strings.ReplaceAll(fmt.Sprintf("% x", digest[:]), " ", ":"); pin != host.Fingerprint {
		t.Fatal("LAN leaf differs from the approved host fingerprint")
	}
}

type subnetTestConn struct {
	net.Conn
	ip     net.IP
	closed bool
}

func (c *subnetTestConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: c.ip, Port: 12345}
}

func (c *subnetTestConn) Close() error {
	c.closed = true
	return nil
}

type subnetTestListener struct {
	net.Listener
	peers []net.Conn
}

func (l *subnetTestListener) Accept() (net.Conn, error) {
	if len(l.peers) == 0 {
		return nil, errors.New("no peers")
	}
	peer := l.peers[0]
	l.peers = l.peers[1:]
	return peer, nil
}

func TestLANListenerClosesOutsideSubnetBeforeTLS(t *testing.T) {
	outsideLAN := &subnetTestConn{ip: net.ParseIP("192.168.10.1")}
	outsidePrivateSpace := &subnetTestConn{ip: net.ParseIP("203.0.113.9")}
	inside := &subnetTestConn{ip: net.ParseIP("192.168.2.10")}
	listener := &localSubnetListener{
		Listener: &subnetTestListener{peers: []net.Conn{outsideLAN, outsidePrivateSpace, inside}},
		subnet:   netip.MustParsePrefix("192.168.2.0/24"),
	}
	peer, err := listener.Accept()
	if err != nil || peer != inside || !outsideLAN.closed || !outsidePrivateSpace.closed || inside.closed {
		t.Fatal("connections outside the LAN were not closed:", err)
	}
}

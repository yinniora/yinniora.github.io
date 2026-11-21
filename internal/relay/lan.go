package relay

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"time"
)

// LANAddresses finds eligible addresses on up, non-virtual local interfaces.
// It includes RFC1918 IPv4 only, leaving public and Tailscale routes separate.
func LANAddresses() []string {
	networks, _ := lanNetworks()
	addresses := make([]string, 0, len(networks))
	for address := range networks {
		addresses = append(addresses, address.String())
	}
	sort.Strings(addresses)
	return addresses
}

func lanNetworks() (map[netip.Addr]netip.Prefix, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	networks := make(map[netip.Addr]netip.Prefix)
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || !keepInterface(iface.Name) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			prefix, err := netip.ParsePrefix(addr.String())
			if err == nil && prefix.Addr().Is4() && prefix.Addr().IsPrivate() {
				networks[prefix.Addr()] = prefix.Masked()
			}
		}
	}
	return networks, nil
}

func ValidLANSignalingURL(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "wss" || u.User != nil || u.Path != "/remote-signal" ||
		u.RawPath != "" || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery {
		return false
	}
	ip, err := netip.ParseAddr(u.Hostname())
	port, portErr := strconv.ParseUint(u.Port(), 10, 16)
	return err == nil && ip.Is4() && ip.IsPrivate() && portErr == nil && port > 0
}

type LANServer struct {
	endpoint string
	server   *http.Server
	cancel   context.CancelFunc
}

func (s *LANServer) URL() string { return s.endpoint }

func (s *LANServer) Close() error {
	s.cancel()
	return s.server.Close()
}

// ListenLAN serves only the host's standalone signaling protocol. The native
// client pins this TLS leaf to the identity shown on the locally approved QR.
func ListenLAN(host *Host, address string) (*LANServer, error) {
	bind, err := netip.ParseAddrPort(address)
	if err != nil || !bind.Addr().Is4() || !bind.Addr().IsPrivate() {
		return nil, errors.New("LAN signaling needs an explicit private IPv4 address and port")
	}
	networks, err := lanNetworks()
	if err != nil {
		return nil, err
	}
	subnet, ok := networks[bind.Addr()]
	if !ok {
		return nil, errors.New("LAN address is not assigned to an active local interface")
	}
	tlsConfig, err := lanTLSConfig(host)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", bind.String())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	mux := http.NewServeMux()
	slots := make(chan struct{}, 24)
	mux.HandleFunc("GET /remote-signal", func(w http.ResponseWriter, r *http.Request) {
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
			host.ServeSignal(w, r)
		default:
			http.Error(w, "Too many LAN connections", http.StatusServiceUnavailable)
		}
	})
	server := &http.Server{
		Handler: mux, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16384,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		_ = server.Serve(tls.NewListener(&localSubnetListener{Listener: listener, subnet: subnet}, tlsConfig))
		cancel()
	}()
	return &LANServer{endpoint: "wss://" + listener.Addr().String() + "/remote-signal", server: server, cancel: cancel}, nil
}

func lanTLSConfig(host *Host) (*tls.Config, error) {
	if host == nil || host.Certificate == nil {
		return nil, errors.New("LAN signaling requires a host identity")
	}
	pem, err := host.Certificate.PEM()
	if err != nil {
		return nil, err
	}
	keyPair, err := tls.X509KeyPair([]byte(pem), []byte(pem))
	if err != nil {
		return nil, err
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{keyPair}}, nil
}

type localSubnetListener struct {
	net.Listener
	subnet netip.Prefix
}

func (l *localSubnetListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		peer, ok := conn.RemoteAddr().(*net.TCPAddr)
		if ok {
			address := peer.AddrPort().Addr().Unmap()
			if address.Is4() && address.IsPrivate() && l.subnet.Contains(address) {
				return conn, nil
			}
		}
		_ = conn.Close()
	}
}

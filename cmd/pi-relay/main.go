// pi-relay knows only room routing and TURN credentials. It has no Mac
// identity key, device credentials, Pi access token or model API key.
package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"pi-web/internal/relay"
)

func main() {
	b := &relay.Broker{Room: os.Getenv("PI_RELAY_ROOM"), HostToken: os.Getenv("PI_RELAY_HOST_TOKEN"),
		TURNSecret: os.Getenv("PI_RELAY_TURN_SECRET"), ClientSecret: os.Getenv("PI_RELAY_CLIENT_SECRET"), RequireClientAuth: true, PublicIP: os.Getenv("PI_RELAY_PUBLIC_IP"), Origin: os.Getenv("PI_RELAY_CLIENT_ORIGIN")}
	if len(b.Room) < 20 || len(b.HostToken) < 32 || len(b.TURNSecret) < 32 || len(b.ClientSecret) < 32 || b.PublicIP == "" || b.Origin == "" {
		log.Fatal("relay configuration is incomplete")
	}
	if setupDir := os.Getenv("PI_RELAY_SETUP_DIR"); setupDir != "" {
		server, err := url.Parse(os.Getenv("PI_RELAY_SERVER_URL"))
		if err != nil || server.Scheme != "https" || server.Hostname() != b.PublicIP || server.User != nil ||
			(server.Path != "" && server.Path != "/") || server.RawQuery != "" || server.Fragment != "" ||
			"https://"+server.Host == b.Origin {
			log.Fatal("relay enrollment requires its separate public HTTPS origin")
		}
		b.SetupHandler = relay.NewSetupHandler(setupDir, relay.ServerProfile{
			ServerURL: strings.TrimRight(server.String(), "/"), Room: b.Room, HostToken: b.HostToken,
			TURNSecret: b.TURNSecret, ClientSecret: b.ClientSecret,
		})
	}
	server := &http.Server{Addr: "127.0.0.1:43120", Handler: b, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16 * 1024}
	log.Fatal(server.ListenAndServe())
}

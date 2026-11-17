// pi-relay knows only room routing and TURN credentials. It has no Mac
// identity key, device credentials, Pi access token or model API key.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"pi-web/internal/relay"
)

func main() {
	b := &relay.Broker{Room: os.Getenv("PI_RELAY_ROOM"), HostToken: os.Getenv("PI_RELAY_HOST_TOKEN"),
		TURNSecret: os.Getenv("PI_RELAY_TURN_SECRET"), PublicIP: os.Getenv("PI_RELAY_PUBLIC_IP"), Origin: os.Getenv("PI_RELAY_CLIENT_ORIGIN")}
	if len(b.Room) < 20 || len(b.HostToken) < 32 || len(b.TURNSecret) < 32 || b.PublicIP == "" || b.Origin == "" {
		log.Fatal("relay configuration is incomplete")
	}
	server := &http.Server{Addr: "127.0.0.1:43120", Handler: b, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16 * 1024}
	log.Fatal(server.ListenAndServe())
}

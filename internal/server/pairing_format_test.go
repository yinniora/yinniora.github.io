package server

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCompactPairingPreservesTicketAndPinWithLessQRData(t *testing.T) {
	expires := time.Now().Add(3 * time.Minute)
	metadata := map[string]any{"version": 1, "fingerprint": strings.TrimSuffix(strings.Repeat("ab:", 32), ":"), "ticket": strings.Repeat("cd", 32), "signalUrl": "wss://relay.example:8443/signal?room=" + strings.Repeat("r", 32), "iceUrl": "https://relay.example:8443/ice?room=" + strings.Repeat("r", 32), "clientUrl": "https://client.example/", "relayTicket": strings.Repeat("t", 165), "relayAuth": true, "expiresAt": expires.UTC().Format(time.RFC3339), "locale": "zh", "directUrl": ""}
	compact, err := compactPairingData(metadata, expires)
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(metadata)
	if len(compact)*100 > len(legacy)*70 {
		t.Fatalf("compact payload is not sufficiently smaller: %d vs %d", len(compact), len(legacy))
	}
	var fields []any
	json.Unmarshal(compact, &fields)
	pin, _ := base64.RawURLEncoding.DecodeString(fields[1].(string))
	ticket, _ := base64.RawURLEncoding.DecodeString(fields[2].(string))
	if len(pin) != 32 || len(ticket) != 32 || pin[0] != 0xab || ticket[0] != 0xcd || int64(fields[6].(float64)) != expires.Unix() {
		t.Fatal("identity, entropy or expiry changed")
	}
	metadata["iceUrl"] = "https://other.example/ice?room=" + strings.Repeat("r", 32)
	if _, err = compactPairingData(metadata, expires); err == nil {
		t.Fatal("nonstandard routes should retain the compatible format")
	}
}

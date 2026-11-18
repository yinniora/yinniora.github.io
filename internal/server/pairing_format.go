package server

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

// Compact only public routing metadata and encode the same random ticket/pin.
// Authentication, expiry and one-use enforcement stay on the Mac unchanged.
func compactPairingData(metadata map[string]any, expires time.Time) ([]byte, error) {
	signal, err := url.Parse(pairingString(metadata["signalUrl"]))
	if err != nil {
		return nil, err
	}
	ice, err := url.Parse(pairingString(metadata["iceUrl"]))
	if err != nil {
		return nil, err
	}
	if signal.Scheme != "wss" || ice.Scheme != "https" || signal.Host != ice.Host || signal.Path != "/signal" || ice.Path != "/ice" || signal.RawQuery != ice.RawQuery || len(signal.Query()) != 1 || len(signal.Query().Get("room")) < 20 {
		return nil, errors.New("nonstandard routing uses the compatible format")
	}
	fingerprint, err := hex.DecodeString(strings.ReplaceAll(pairingString(metadata["fingerprint"]), ":", ""))
	if err != nil || len(fingerprint) != 32 {
		return nil, errors.New("invalid fingerprint")
	}
	ticket, err := hex.DecodeString(pairingString(metadata["ticket"]))
	if err != nil || len(ticket) != 32 {
		return nil, errors.New("invalid ticket")
	}
	return json.Marshal([]any{2, base64.RawURLEncoding.EncodeToString(fingerprint), base64.RawURLEncoding.EncodeToString(ticket), "https://" + signal.Host, signal.Query().Get("room"), pairingString(metadata["relayTicket"]), expires.Unix(), pairingString(metadata["locale"]), pairingString(metadata["directUrl"])})
}
func pairingString(value any) string { result, _ := value.(string); return result }

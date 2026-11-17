package relay

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

type relayAccessProof struct {
	PublicKey json.RawMessage `json:"publicKey"`
	Signature string          `json:"signature"`
	Ticket    string          `json:"ticket,omitempty"`
	Timestamp int64           `json:"timestamp,omitempty"`
	Nonce     string          `json:"nonce,omitempty"`
}

func verifyRelaySignature(proof relayAccessProof, message string) (string, error) {
	key, id, err := ParsePublicKey(proof.PublicKey)
	if err != nil {
		return "", err
	}
	signature, err := base64.RawURLEncoding.DecodeString(proof.Signature)
	if err != nil || len(signature) != 64 {
		return "", errors.New("invalid relay proof")
	}
	hash := sha256.Sum256([]byte(message))
	if !ecdsa.Verify(key, hash[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return "", errors.New("invalid relay signature")
	}
	return id, nil
}
func relayTicket(secret, room, nonce string, expiry time.Time) string {
	body := fmt.Sprintf("%d:%s", expiry.Unix(), nonce)
	encoded := base64.RawURLEncoding.EncodeToString([]byte(body))
	return encoded + "." + RelayProof(secret, "enroll:"+room+":"+body)
}
func (b *Broker) allowDevice(id, ticket string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.approved[id] {
		return true
	}
	if b.ClientSecret == "" || len(ticket) > 512 {
		return false
	}
	parts := strings.Split(ticket, ".")
	if len(parts) != 2 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var expiry int64
	var nonce string
	if _, err = fmt.Sscanf(string(raw), "%d:%s", &expiry, &nonce); err != nil || len(nonce) != 64 || expiry < time.Now().Unix() || expiry > time.Now().Add(4*time.Minute).Unix() {
		return false
	}
	if _, err = hex.DecodeString(nonce); err != nil {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(RelayProof(b.ClientSecret, "enroll:"+b.Room+":"+string(raw)))) != 1 {
		return false
	}
	if b.enrollments == nil {
		b.enrollments = map[string]relayEnrollment{}
	}
	for key, entry := range b.enrollments {
		if entry.expires < time.Now().Unix() {
			delete(b.enrollments, key)
		}
	}
	if old, ok := b.enrollments[nonce]; ok {
		return old.id == id
	}
	if len(b.enrollments) >= 128 {
		return false
	}
	b.enrollments[nonce] = relayEnrollment{id: id, expires: expiry}
	return true
}
func (b *Broker) verifyICE(header string) bool {
	if header == "" {
		return !b.RequireClientAuth
	}
	if !strings.HasPrefix(header, "PiRelay ") || len(header) > 4096 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(header, "PiRelay "))
	if err != nil {
		return false
	}
	var proof relayAccessProof
	if json.Unmarshal(raw, &proof) != nil || len(proof.Nonce) != 32 || proof.Timestamp < time.Now().Add(-time.Minute).Unix() || proof.Timestamp > time.Now().Add(time.Minute).Unix() {
		return false
	}
	id, err := verifyRelaySignature(proof, fmt.Sprintf("pi-relay-ice-v1:%s:%d:%s", b.Room, proof.Timestamp, proof.Nonce))
	if err != nil || !b.allowDevice(id, proof.Ticket) {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.replays == nil {
		b.replays = map[string]int64{}
	}
	for nonce, stamp := range b.replays {
		if stamp < time.Now().Add(-2*time.Minute).Unix() {
			delete(b.replays, nonce)
		}
	}
	if _, ok := b.replays[proof.Nonce]; ok || len(b.replays) >= 4096 {
		return false
	}
	b.replays[proof.Nonce] = time.Now().Unix()
	return true
}

type relayEnrollment struct {
	id      string
	expires int64
}
type relayRate struct {
	start time.Time
	count int
}

func (b *Broker) admit(ip string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if b.rates == nil {
		b.rates = map[string]relayRate{}
	}
	for key, rate := range b.rates {
		if now.Sub(rate.start) > time.Minute {
			delete(b.rates, key)
		}
	}
	if len(b.rates) >= 4096 {
		return false
	}
	rate := b.rates[ip]
	if rate.start.IsZero() {
		rate.start = now
	}
	rate.count++
	b.rates[ip] = rate
	return rate.count <= 120
}

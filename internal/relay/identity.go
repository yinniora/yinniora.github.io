// Package relay carries authenticated HTTP over WebRTC's encrypted DTLS data
// channels. Signaling and TURN servers are deliberately outside the trust boundary.
package relay

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

type PublicKey struct {
	KTY string `json:"kty"`
	CRV string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	D   string `json:"d,omitempty"`
}

func ParsePublicKey(raw json.RawMessage) (*ecdsa.PublicKey, string, error) {
	var jwk PublicKey
	if len(raw) > 2048 || json.Unmarshal(raw, &jwk) != nil || jwk.KTY != "EC" || jwk.CRV != "P-256" || jwk.D != "" {
		return nil, "", errors.New("invalid device public key")
	}
	x, e1 := base64.RawURLEncoding.DecodeString(jwk.X)
	y, e2 := base64.RawURLEncoding.DecodeString(jwk.Y)
	if e1 != nil || e2 != nil || len(x) != 32 || len(y) != 32 {
		return nil, "", errors.New("invalid device key coordinates")
	}
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !key.Curve.IsOnCurve(key.X, key.Y) {
		return nil, "", errors.New("invalid device curve point")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256(der)
	return key, hex.EncodeToString(hash[:]), nil
}

func VerifyDeviceProof(raw json.RawMessage, nonce, fingerprint, signature string) (string, error) {
	key, id, err := ParsePublicKey(raw)
	if err != nil {
		return "", err
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != 64 {
		return "", errors.New("invalid device proof")
	}
	hash := sha256.Sum256([]byte("pi-device-auth-v1:" + nonce + ":" + fingerprint))
	if !ecdsa.Verify(key, hash[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return "", errors.New("device proof did not match this connection")
	}
	return id, nil
}

func LoadIdentity(filename string) (*webrtc.Certificate, string, error) {
	var certificate *webrtc.Certificate
	if data, err := readPrivateFile(filename); err == nil {
		certificate, err = webrtc.CertificateFromPEM(string(data))
		if err != nil {
			return nil, "", err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	} else {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, "", err
		}
		serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if err != nil {
			return nil, "", err
		}
		certificate, err = webrtc.NewCertificate(key, x509.Certificate{SerialNumber: serial,
			NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
			KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		if err != nil {
			return nil, "", err
		}
		pem, err := certificate.PEM()
		if err != nil {
			return nil, "", err
		}
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			return nil, "", err
		}
		file, err := createPrivateFile(filename)
		if err != nil {
			return nil, "", err
		}
		_, writeErr := file.WriteString(pem)
		closeErr := file.Close()
		if writeErr != nil {
			return nil, "", writeErr
		}
		if closeErr != nil {
			return nil, "", closeErr
		}
	}
	fingerprints, err := certificate.GetFingerprints()
	if err != nil {
		return nil, "", err
	}
	for _, fingerprint := range fingerprints {
		if fingerprint.Algorithm == "sha-256" {
			return certificate, strings.ToLower(fingerprint.Value), nil
		}
	}
	return nil, "", errors.New("identity has no SHA-256 fingerprint")
}

package relay

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testDevice(t *testing.T) (*ecdsa.PrivateKey, json.RawMessage) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(PublicKey{KTY: "EC", CRV: "P-256", X: base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), Y: base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))})
	return key, raw
}
func signProof(t *testing.T, key *ecdsa.PrivateKey, nonce, fp string) string {
	t.Helper()
	hash := sha256.Sum256([]byte("pi-device-auth-v1:" + nonce + ":" + fp))
	r, s, err := ecdsa.Sign(rand.Reader, key, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...))
}
func TestProofBoundToNonceAndMac(t *testing.T) {
	key, raw := testDevice(t)
	signature := signProof(t, key, "fresh", "mac-one")
	if id, err := VerifyDeviceProof(raw, "fresh", "mac-one", signature); err != nil || len(id) != 64 {
		t.Fatalf("valid proof: %q %v", id, err)
	}
	for _, tc := range []struct{ nonce, fp string }{{"replayed", "mac-one"}, {"fresh", "mac-two"}} {
		if _, err := VerifyDeviceProof(raw, tc.nonce, tc.fp, signature); err == nil {
			t.Fatal("accepted replay or different Mac")
		}
	}
	var jwk PublicKey
	json.Unmarshal(raw, &jwk)
	jwk.D = "private"
	bad, _ := json.Marshal(jwk)
	if _, _, err := ParsePublicKey(bad); err == nil {
		t.Fatal("accepted private JWK")
	}
	jwk.D = ""
	jwk.X = strings.Repeat("A", 43)
	jwk.Y = jwk.X
	bad, _ = json.Marshal(jwk)
	if _, _, err := ParsePublicKey(bad); err == nil {
		t.Fatal("accepted point off curve")
	}
}
func TestIdentityPersistsPrivately(t *testing.T) {
	file := filepath.Join(t.TempDir(), "remote", "identity.pem")
	_, first, err := LoadIdentity(file)
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := LoadIdentity(file)
	if err != nil || first != second {
		t.Fatal("identity changed on restart", err)
	}
	info, _ := os.Stat(file)
	// Windows FileMode does not report POSIX owner/group permission bits.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("identity is not private")
	}
	_, other, err := LoadIdentity(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil || other == first {
		t.Fatal("identity not unique", err)
	}
}
func TestRequestBoundary(t *testing.T) {
	for _, path := range []string{"http://localhost/api/settings", "//evil/api/settings", "/remote-signal", "/", "/private/key", "/api/%zz"} {
		if validRequestPath(path) {
			t.Fatalf("accepted %q", path)
		}
	}
	for _, path := range []string{"/api/assets?id=x", "/api/asset?path=video.mp4", "/events", "/share?id=x"} {
		if !validRequestPath(path) {
			t.Fatalf("rejected %q", path)
		}
	}
}

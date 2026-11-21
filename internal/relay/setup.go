package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NewSetupHandler redeems VPS administrator-issued bootstrap tokens. These
// tokens authorize the relay profile only. Device pairing stays on the host.
func NewSetupHandler(directory string, profile ServerProfile) http.Handler {
	var redemption sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.RawQuery != "" || r.ContentLength != 0 {
			http.Error(w, "use the authorization header", http.StatusBadRequest)
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || len(token) != sha256.Size*2 || strings.ToLower(token) != token {
			http.Error(w, "invalid or expired setup code", http.StatusUnauthorized)
			return
		}
		if _, err := hex.DecodeString(token); err != nil {
			http.Error(w, "invalid or expired setup code", http.StatusUnauthorized)
			return
		}
		digest := sha256.Sum256([]byte(token))
		path := filepath.Join(directory, hex.EncodeToString(digest[:]))
		redemption.Lock()
		redeemed := redeemSetupToken(path, time.Now())
		redemption.Unlock()
		if !redeemed {
			http.Error(w, "invalid or expired setup code", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(profile)
	})
}

func redeemSetupToken(path string, now time.Time) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 20 {
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	expires, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || expires <= now.Unix() {
		return false
	}
	// Claim the token before deleting it. The installer can also remove an
	// older token when generating a new one, but only a successful rename
	// of the original token authorizes this response.
	claimed := path + ".redeemed"
	if err := os.Rename(path, claimed); err != nil {
		return false
	}
	_ = os.Remove(claimed)
	return true
}

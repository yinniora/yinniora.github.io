package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSetupCodeIsPrivateAndSingleUse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the setup endpoint is deployed on Linux with private file permissions")
	}
	directory := t.TempDir()
	profile := ServerProfile{ServerURL: "https://relay.example.com", Room: "test", HostToken: "host", TURNSecret: "turn", ClientSecret: "client"}
	brokerForDirectory := func() http.Handler {
		return &Broker{SetupHandler: NewSetupHandler(directory, profile)}
	}
	handler := brokerForDirectory()
	store := func(token string, expires time.Time, mode os.FileMode) {
		t.Helper()
		digest := sha256.Sum256([]byte(token))
		if err := os.WriteFile(filepath.Join(directory, hex.EncodeToString(digest[:])), fmt.Appendf(nil, "%d\n", expires.Unix()), mode); err != nil {
			t.Fatal(err)
		}
	}
	request := func(handler http.Handler, method, path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Origin", "https://device.example.com")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	valid := strings.Repeat("a", 64)
	expired := strings.Repeat("b", 64)
	worldReadable := strings.Repeat("c", 64)
	store(valid, time.Now().Add(time.Minute), 0600)
	store(expired, time.Now().Add(-time.Minute), 0600)
	store(worldReadable, time.Now().Add(time.Minute), 0644)
	for _, tt := range []struct {
		method, path, token string
		status              int
	}{
		{"GET", "/setup", valid, http.StatusMethodNotAllowed},
		{"POST", "/setup?code=" + valid, valid, http.StatusBadRequest},
		{"POST", "/setup", expired, http.StatusUnauthorized},
		{"POST", "/setup", worldReadable, http.StatusUnauthorized},
		{"POST", "/setup", strings.Repeat("d", 64), http.StatusUnauthorized},
		{"POST", "/setup", "bad", http.StatusUnauthorized},
	} {
		if response := request(handler, tt.method, tt.path, tt.token); response.Code != tt.status || strings.Contains(response.Body.String(), profile.ServerURL) {
			t.Fatalf("%s: status %d, want %d", tt.method, response.Code, tt.status)
		}
	}
	const attempts = 8
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, attempts)
	brokers := []http.Handler{handler, brokerForDirectory()}
	for attempt := range attempts {
		wg.Go(func() { results <- request(brokers[attempt%len(brokers)], http.MethodPost, "/setup", valid) })
	}
	wg.Wait()
	close(results)
	var redeemed int
	for response := range results {
		if response.Code == http.StatusUnauthorized {
			continue
		}
		var actual ServerProfile
		if response.Code != http.StatusOK || json.NewDecoder(response.Body).Decode(&actual) != nil || actual != profile {
			t.Fatalf("failed to redeem profile: status %d", response.Code)
		}
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("setup profile must not be cached or shared with websites")
		}
		redeemed++
	}
	if redeemed != 1 {
		t.Fatalf("redeemed %d times, want 1", redeemed)
	}
}

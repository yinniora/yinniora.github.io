package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-web/internal/auth"
	"pi-web/internal/sessions"
)

func assetTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root, cwd := t.TempDir(), t.TempDir()
	dir := filepath.Join(root, "project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": "asset-session", "cwd": cwd, "timestamp": time.Now().Add(-time.Hour).Format(time.RFC3339Nano)})
	message, _ := json.Marshal(map[string]any{"type": "message", "id": "write-old", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "name": "write", "id": "w1", "arguments": map[string]any{"path": "old.svg", "content": "<svg/>"}}}}})
	if err := os.WriteFile(filepath.Join(dir, "a.jsonl"), append(append(header, '\n'), append(message, '\n')...), 0600); err != nil {
		t.Fatal(err)
	}
	return &Server{sessionsDir: root, cache: sessions.NewCache(), auth: auth.New("test-token")}, cwd
}

func createAsset(t *testing.T, cwd, name string) {
	t.Helper()
	full := filepath.Join(cwd, name)
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAssetsListRecentFilesAndReferencedOlderFiles(t *testing.T) {
	s, cwd := assetTestServer(t)
	for _, name := range []string{"drawing.svg", "clip.mp4", "old.svg", "unrelated.pdf", ".env.json", "private/hidden.png", "auth.json"} {
		createAsset(t, cwd, name)
	}
	old := time.Now().Add(-24 * time.Hour)
	for _, name := range []string{"old.svg", "unrelated.pdf"} {
		if err := os.Chtimes(filepath.Join(cwd, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	s.handleAssets(w, httptest.NewRequest("GET", "/api/assets?id=a.jsonl", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Assets []workspaceAsset `json:"assets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, asset := range body.Assets {
		names[asset.Path] = true
	}
	if len(names) != 3 || !names["drawing.svg"] || !names["clip.mp4"] || !names["old.svg"] {
		t.Fatalf("unexpected assets: %v", names)
	}
}

func TestSessionGalleryExcludesUnrelatedRecentFiles(t *testing.T) {
	s, cwd := assetTestServer(t)
	createAsset(t, cwd, "old.svg")
	createAsset(t, cwd, "from-another-conversation.svg")
	w := httptest.NewRecorder()
	s.handleAssets(w, httptest.NewRequest("GET", "/api/assets?id=a.jsonl&scope=session", nil))
	var body struct {
		Assets []workspaceAsset `json:"assets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(body.Assets) != 1 || body.Assets[0].Path != "old.svg" {
		t.Fatalf("session gallery listed an unrelated file: %d %+v", w.Code, body.Assets)
	}
}

func TestAssetRejectsTraversalHiddenPathsAndEscapingSymlinks(t *testing.T) {
	s, cwd := assetTestServer(t)
	outside := filepath.Join(t.TempDir(), "outside.svg")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(cwd, "escape.svg")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside.svg", outside, ".ssh/key.png", "private/x.png", "auth.json", "a/../b.svg", "escape.svg"} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.handleAsset(w, httptest.NewRequest("GET", "/api/asset?id=a.jsonl&path="+url.QueryEscape(name), nil))
			if w.Code != 400 && w.Code != 404 {
				t.Fatalf("status = %d", w.Code)
			}
			if strings.Contains(w.Body.String(), "outside") {
				t.Fatal("file content or private path leaked")
			}
		})
	}
}

func TestVideoAssetSupportsByteRangesAndSVGNeverExecutesInAppOrigin(t *testing.T) {
	s, cwd := assetTestServer(t)
	createAsset(t, cwd, "video.mp4")
	createAsset(t, cwd, "drawing.svg")
	r := httptest.NewRequest("GET", "/api/asset?id=a.jsonl&path=video.mp4&inline=1", nil)
	r.Header.Set("Range", "bytes=2-5")
	w := httptest.NewRecorder()
	s.handleAsset(w, r)
	if w.Code != 206 || w.Body.String() != "2345" || w.Header().Get("Content-Range") != "bytes 2-5/10" {
		t.Fatalf("range response: %d %s %s", w.Code, w.Body.String(), w.Header().Get("Content-Range"))
	}
	w = httptest.NewRecorder()
	s.handleAsset(w, httptest.NewRequest("GET", "/api/asset?id=a.jsonl&path=drawing.svg&inline=1", nil))
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") || w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(w.Header().Get("Content-Security-Policy"), "sandbox;") {
		t.Fatal("SVG response lost its download/sandbox boundary", w.Code, w.Header())
	}
}

func TestAssetEndpointsRequireExistingSessionAndAuthentication(t *testing.T) {
	s, cwd := assetTestServer(t)
	createAsset(t, cwd, "drawing.svg")
	for _, route := range []string{"/api/assets?id=a.jsonl", "/api/asset?id=a.jsonl&path=drawing.svg"} {
		w := httptest.NewRecorder()
		handler := s.handleAssets
		if strings.HasPrefix(route, "/api/asset?") {
			handler = s.handleAsset
		}
		s.auth.Wrap(handler)(w, httptest.NewRequest(http.MethodGet, route, nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated response: %d", w.Code)
		}
	}
}

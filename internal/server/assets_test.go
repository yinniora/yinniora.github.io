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
	transcript := append(header, '\n')
	for _, line := range []string{
		`{"type":"message","id":"writes","message":{"role":"assistant","content":[{"type":"toolCall","name":"write","id":"w1","arguments":{"path":"old.svg","content":"<svg/>"}},{"type":"toolCall","name":"write","id":"w2","arguments":{"path":"failed.svg","content":"<svg/>"}},{"type":"toolCall","name":"write","id":"w3","arguments":{"path":"pending.svg","content":"<svg/>"}},{"type":"toolCall","name":"read","id":"r1","arguments":{"path":"read-only.svg"}}]}}`,
		`{"type":"message","id":"write-result","message":{"role":"toolResult","toolCallId":"w1","isError":false}}`,
		`{"type":"message","id":"failed-result","message":{"role":"toolResult","toolCallId":"w2","isError":true}}`,
		`{"type":"message","id":"read-result","message":{"role":"toolResult","toolCallId":"r1","isError":false}}`,
		`{"type":"message","id":"source-calls","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"source-read","arguments":{"path":"src/inspected.ts"}},{"type":"toolCall","name":"edit","id":"source-edit","arguments":{"path":"src/failed.ts"}}]}}`,
		`{"type":"message","id":"source-read-result","message":{"role":"toolResult","toolCallId":"source-read","isError":false}}`,
		`{"type":"message","id":"source-edit-result","message":{"role":"toolResult","toolCallId":"source-edit","isError":true}}`,
	} {
		transcript = append(append(transcript, line...), '\n')
	}
	if err := os.WriteFile(filepath.Join(dir, "a.jsonl"), transcript, 0600); err != nil {
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
	for _, name := range []string{"old.svg", "read-only.svg", "failed.svg", "pending.svg", "from-another-conversation.svg"} {
		createAsset(t, cwd, name)
	}
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

func TestSessionGalleryIncludesExplicitLinksToConfinedFiles(t *testing.T) {
	s, cwd := assetTestServer(t)
	createAsset(t, cwd, "nested/clip.mp4")
	createAsset(t, cwd, "private/secret.svg")
	if err := os.Symlink(filepath.Join(cwd, "private"), filepath.Join(cwd, "alias")); err != nil {
		t.Fatal(err)
	}
	query := url.Values{"id": {"a.jsonl"}, "scope": {"session"}, "link": {"nested/clip.mp4", "alias/secret.svg", "private/secret.svg"}}
	w := httptest.NewRecorder()
	s.handleAssets(w, httptest.NewRequest("GET", "/api/assets?"+query.Encode(), nil))
	var body struct {
		Assets []workspaceAsset `json:"assets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(body.Assets) != 1 || body.Assets[0].Path != "nested/clip.mp4" {
		t.Fatalf("unexpected linked assets: %d %+v", w.Code, body.Assets)
	}
	w = httptest.NewRecorder()
	s.handleAsset(w, httptest.NewRequest("GET", "/api/asset?id=a.jsonl&path=alias/secret.svg", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("an in-workspace symlink bypassed path restrictions:", w.Code)
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

func TestSourcePreviewRequiresASuccessfulRecordedOperation(t *testing.T) {
	s, cwd := assetTestServer(t)
	for _, name := range []string{"src/inspected.ts", "src/failed.ts", "src/unrelated.ts"} {
		createAsset(t, cwd, name)
		w := httptest.NewRecorder()
		query := url.Values{"id": {"a.jsonl"}, "path": {name}}
		s.handleAsset(w, httptest.NewRequest(http.MethodGet, "/api/asset?"+query.Encode(), nil))
		if name == "src/inspected.ts" {
			if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
				t.Fatalf("recorded source preview: %d %s", w.Code, w.Header().Get("Content-Type"))
			}
		} else if w.Code != http.StatusNotFound {
			t.Fatalf("unexpected access to %s: %d", name, w.Code)
		}
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

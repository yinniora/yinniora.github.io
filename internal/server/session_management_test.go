package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-web/internal/auth"
)

func TestTrashRestorePreservesSessionAndProject(t *testing.T) {
	s := newTestServer(t)
	dir := filepath.Join(s.sessionsDir, "project")
	writeSessionWithCWD(t, dir, "test.jsonl", t.TempDir())
	path := filepath.Join(dir, "test.jsonl")
	before, _ := os.ReadFile(path)
	for _, step := range []struct {
		restore bool
		visible int
	}{{false, 0}, {false, 0}, {true, 1}, {true, 1}} {
		body, _ := json.Marshal(map[string]any{"id": "test.jsonl", "restore": step.restore})
		w := httptest.NewRecorder()
		s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(string(body))))
		if w.Code != 200 {
			t.Fatalf("trash status %d: %s", w.Code, w.Body)
		}
		all, err := s.loadSummaries()
		if err != nil || len(all) != step.visible {
			t.Fatalf("visible=%d want=%d err=%v", len(all), step.visible, err)
		}
		got, _ := os.ReadFile(path)
		if string(got) != string(before) {
			t.Fatal("trash changed session JSONL")
		}
		w = httptest.NewRecorder()
		s.visibleSession(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })(w, httptest.NewRequest("GET", "/api/session?id=test.jsonl", nil))
		want := 410
		if step.restore {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("access=%d want=%d", w.Code, want)
		}
	}
}

func TestTrashValidationAndListing(t *testing.T) {
	s := newTestServer(t)
	for _, id := range []string{"", "../outside.jsonl", "missing.jsonl"} {
		body, _ := json.Marshal(map[string]string{"id": id})
		w := httptest.NewRecorder()
		s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(string(body))))
		if w.Code < 400 {
			t.Fatalf("accepted invalid id %q", id)
		}
	}
	w := httptest.NewRecorder()
	s.handleTrash(w, httptest.NewRequest("GET", "/api/trash", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"sessions":[]`) {
		t.Fatalf("empty trash: %d %s", w.Code, w.Body)
	}
}

func TestPermanentDeletePreservesProjectFiles(t *testing.T) {
	s := newTestServer(t)
	project := t.TempDir()
	projectFile := filepath.Join(project, "keep.txt")
	os.WriteFile(projectFile, []byte("keep"), 0600)
	dir := filepath.Join(s.sessionsDir, "project")
	writeSessionWithCWD(t, dir, "purge.jsonl", project)
	call := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(body)))
		return w
	}

	if _, err := s.chatQueue.Add("purge.jsonl", "private queued text", "private queued text"); err != nil {
		t.Fatal(err)
	}
	if w := call(`{"id":"purge.jsonl","permanent":true}`); w.Code != 200 {
		t.Fatalf("purge failed %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, "purge.jsonl")); !os.IsNotExist(err) {
		t.Fatal("session file survived purge")
	}
	if data, err := os.ReadFile(projectFile); err != nil || string(data) != "keep" {
		t.Fatal("project file changed")
	}
	snapshot, err := s.chatQueue.List("purge.jsonl")
	if err != nil || len(snapshot.Items) != 0 {
		t.Fatal("queued content survived purge")
	}
	if w := call(`{"id":"purge.jsonl","restore":true}`); w.Code < 400 {
		t.Fatal("restored permanently deleted session")
	}
}

func TestConnectionAllowlistAndLogout(t *testing.T) {
	s := newTestServer(t)
	s.auth = auth.New("test-token")
	t.Setenv("PI_WEB_CONNECTIONS", `[{"id":"remote","url":"https://example.com:8443"}]`)
	for _, tc := range []struct {
		target string
		want   int
	}{{"remote", 200}, {"https://evil.test", 400}, {"", 400}} {
		body, _ := json.Marshal(map[string]string{"target": tc.target, "session": "test.jsonl"})
		w := httptest.NewRecorder()
		s.handleConnect(w, httptest.NewRequest("POST", "/api/connect", strings.NewReader(string(body))))
		if w.Code != tc.want {
			t.Fatalf("%s: %d", tc.target, w.Code)
		}
		if tc.want == 200 && (!strings.Contains(w.Body.String(), "pair=") || strings.Contains(w.Body.String(), "token=")) {
			t.Fatal("unsafe handover")
		}
	}
	w := httptest.NewRecorder()
	s.handleLogout(w, httptest.NewRequest("POST", "/api/logout", nil))
	if w.Code != 200 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not expire cookie")
	}
}

func TestConfiguredConnectionsRejectUnsafeDestinations(t *testing.T) {
	for _, tc := range []struct {
		url  string
		want int
	}{
		{"https://example.com", 1}, {"http://127.0.0.1:31415", 1}, {"http://100.64.0.1:31415", 1},
		{"http://192.168.1.2:31415", 1}, {"http://example.com", 0}, {"https://user:pass@example.com", 0},
		{"https://example.com/?token=secret", 0}, {"https://example.com/#secret", 0}, {"https://example.com/path", 0},
		{"javascript:alert(1)", 0}, {"file:///etc/passwd", 0},
	} {
		t.Run(tc.url, func(t *testing.T) {
			value, _ := json.Marshal([]connection{{ID: "remote", URL: tc.url}})
			t.Setenv("PI_WEB_CONNECTIONS", string(value))
			if got := configuredConnections(); len(got) != tc.want {
				t.Fatalf("got %d want %d", len(got), tc.want)
			}
		})
	}
}

func TestManagementRoutesRequireAuthentication(t *testing.T) {
	s := newTestServer(t)
	s.auth = auth.New("test-token")
	mux := http.NewServeMux()
	s.Register(mux)
	for _, path := range []string{"/api/trash", "/api/connections", "/api/connect", "/api/export-markdown", "/api/logout"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(`{}`)))
		if w.Code != 401 {
			t.Fatalf("%s accepted unauthenticated access: %d", path, w.Code)
		}
	}
}

func TestMarkdownExportOmitsToolsAndAttachesDownload(t *testing.T) {
	s := newTestServer(t)
	dir := filepath.Join(s.sessionsDir, "project")
	os.MkdirAll(dir, 0700)
	data := `{"type":"session","version":3,"id":"test","cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}
{"type":"message","id":"a","message":{"role":"user","content":"hello"}}
{"type":"message","id":"b","message":{"role":"assistant","content":[{"type":"text","text":"world"},{"type":"toolCall","name":"bash","arguments":{"command":"private"}}]}}
{"type":"message","id":"c","message":{"role":"toolResult","content":"tool-secret"}}
`
	os.WriteFile(filepath.Join(dir, "test.jsonl"), []byte(data), 0600)
	w := httptest.NewRecorder()
	s.handleMarkdownExport(w, httptest.NewRequest("GET", "/api/export-markdown?id=test.jsonl", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "hello") || !strings.Contains(w.Body.String(), "world") || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "tool-secret") {
		t.Fatalf("bad export %d %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("not a download")
	}
}

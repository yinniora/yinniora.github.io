package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-web/internal/sessions"
)

// writeSessionWithNMessages scaffolds a session JSONL with `n` message
// entries (plus the leading session header line — so total entries in the
// parsed Session is n+1). Used to exercise the pagination thresholds
// (default 1500 entries → tail-truncate to 1000).
func writeSessionWithNMessages(t *testing.T, root, project, name string, n int) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	cwd := filepath.Join(root, "cwd")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString(`{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":` + jsonString(cwd) + `}` + "\n")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, `{"type":"message","id":"id%06d","parentId":null,"timestamp":"2026-05-06T00:00:%02d.000Z","message":{"role":"user","content":"m%d"}}`+"\n", i, i%60, i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHandleApiSession_PaginationWindowed(t *testing.T) {
	root := t.TempDir()
	const messages = 50
	const totalEntries = messages + 1 // session header is entries[0]
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// Window [10, 15) → 5 entries starting at entries[10].
	// Since entries[0] is the session header, entries[10] is message #9 (id000009).
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=10&count=5", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if resp.From != 10 {
		t.Errorf("from = %d, want 10", resp.From)
	}
	if got := len(resp.Entries); got != 5 {
		t.Errorf("got %d entries, want 5", got)
	}
	firstID, _ := resp.Entries[0]["id"].(string)
	if firstID != "id000009" {
		t.Errorf("first entry id = %q, want id000009", firstID)
	}
}

func TestHandleApiSession_PaginationClampsBeyondEnd(t *testing.T) {
	root := t.TempDir()
	const messages = 20
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// from=15, count=100 → should clamp to entries[15:21] = 6 entries
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=15&count=100", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if got := len(resp.Entries); got != totalEntries-15 {
		t.Errorf("clamped entries = %d, want %d", got, totalEntries-15)
	}
}

func TestHandleApiSession_NoPaginationByDefault(t *testing.T) {
	root := t.TempDir()
	const messages = 30
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if got := len(resp.Entries); got != totalEntries {
		t.Errorf("default (no params) returned %d entries, want all %d", got, totalEntries)
	}
	if resp.From != 0 {
		t.Errorf("from = %d, want 0", resp.From)
	}
}

func TestHandleApiSession_InvalidParamsReturnFull(t *testing.T) {
	root := t.TempDir()
	const messages = 12
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// from=abc (invalid) → should ignore pagination and return full set.
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=abc&count=5", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Entries) != totalEntries {
		t.Errorf("invalid params: got %d entries, want %d", len(resp.Entries), totalEntries)
	}
}

func TestSessionWindowCapsInitialBytesAndReturnsOnlyNewEntries(t *testing.T) {
	root := t.TempDir()
	path := writeSessionWithNMessages(t, root, "proj", "s.jsonl", 1)
	initial, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var content strings.Builder
	content.Write(initial)
	for i := range 16 {
		fmt.Fprintf(&content, "{\"type\":\"message\",\"id\":\"large-%d\",\"message\":{\"role\":\"user\",\"content\":\"%s\"}}\n", i, strings.Repeat("x", 100*1024))
	}
	if err := os.WriteFile(path, []byte(content.String()), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}
	get := func(params string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.handleApiSession(w, httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&window=1"+params, nil))
		return w
	}
	type window struct {
		Entries     []map[string]any `json:"entries"`
		Total       int              `json:"total"`
		From        int              `json:"from"`
		Revision    string           `json:"revision"`
		Delta       bool             `json:"delta"`
		RecentBytes int              `json:"recentBytes"`
	}
	decode := func(w *httptest.ResponseRecorder) window {
		var data window
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &data) != nil {
			t.Fatal("invalid session window", w.Code)
		}
		return data
	}
	first := decode(get(""))
	if first.Total != 18 || first.From == 0 || first.From+len(first.Entries) != first.Total || first.RecentBytes > sessionWindowBytes {
		t.Fatal("cold transcript was not restricted to a recent byte window")
	}
	params := fmt.Sprintf("&known=%d&revision=%s", first.Total, first.Revision)
	if next := decode(get(params)); !next.Delta || len(next.Entries) != 0 || next.Revision != first.Revision {
		t.Fatal("unchanged transcript was retransmitted")
	}
	content.WriteString("{\"type\":\"session_info\",\"name\":\"Latest title\"}\n")
	if err := os.WriteFile(path, []byte(content.String()), 0600); err != nil {
		t.Fatal(err)
	}
	if next := decode(get(params)); !next.Delta || next.From != first.Total || len(next.Entries) != 1 || next.Revision == first.Revision {
		t.Fatal("server did not return the single appended entry")
	}
	changed := strings.Replace(content.String(), "\"content\":\"m0\"", "\"content\":\"changed\"", 1)
	if err := os.WriteFile(path, []byte(changed), 0600); err != nil {
		t.Fatal(err)
	}
	if next := decode(get(params)); next.Delta || next.From == 0 || next.Total != 19 {
		t.Fatal("a rewritten prefix must refresh the recent window")
	}
	if w := get(params + "&from=0&count=2"); w.Code != http.StatusConflict {
		t.Fatalf("an old revision must not prepend a rewritten history, got %d", w.Code)
	}
	if whole := decode(get("&full=1")); whole.From != 0 || len(whole.Entries) != whole.Total {
		t.Fatal("a link to an older entry must be able to load its history")
	}
}

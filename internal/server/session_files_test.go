package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func cleanupSession(t *testing.T, s *Server, id, cwd string, start time.Time, calls ...map[string]any) {
	t.Helper()
	dir := filepath.Join(s.sessionsDir, "cleanup")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": id, "cwd": cwd, "timestamp": start.Format(time.RFC3339Nano)})
	rows := []string{string(header)}
	for i, call := range calls {
		key := string(rune('a' + i))
		call["id"] = key
		call["type"] = "toolCall"
		entry, _ := json.Marshal(map[string]any{"type": "message", "id": key, "message": map[string]any{"role": "assistant", "content": []any{call}}})
		rows = append(rows, string(entry))
		result, _ := json.Marshal(map[string]any{"type": "message", "id": key + "-result", "message": map[string]any{"role": "toolResult", "toolCallId": key, "isError": call["failed"] == true}})
		rows = append(rows, string(result))
	}
	if err := os.WriteFile(filepath.Join(dir, id), []byte(strings.Join(rows, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestSessionCleanupOwnershipAndContainment(t *testing.T) {
	s := newTestServer(t)
	cwd := t.TempDir()
	start := time.Now().Add(-time.Minute)
	for _, name := range []string{"owned.txt", "changed.txt", "failed.txt", "shared.txt", "preexisting.txt", "outside.txt"} {
		if err := os.WriteFile(filepath.Join(cwd, name), []byte("created"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(outside, []byte("created"), 0600)
	os.Symlink(outside, filepath.Join(cwd, "link.txt"))
	calls := []map[string]any{}
	for _, name := range []string{"owned.txt", "changed.txt", "failed.txt", "shared.txt", "link.txt", "../escape.txt"} {
		calls = append(calls, map[string]any{"name": "write", "failed": name == "failed.txt", "arguments": map[string]any{"path": name, "content": "created"}})
	}
	cleanupSession(t, s, "owner.jsonl", cwd, start, calls...)
	cleanupSession(t, s, "reader.jsonl", cwd, start, map[string]any{"name": "read", "arguments": map[string]any{"path": "shared.txt"}})
	os.WriteFile(filepath.Join(cwd, "changed.txt"), []byte("changed later"), 0600)
	files, _, err := s.sessionCleanupFiles("owner.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if len(files) != 1 || files[0].Path != "owned.txt" {
			t.Fatalf("unexpected candidates: %+v", files)
		}
	} else if len(files) != 0 {
		t.Fatal("guessed creation time on unsupported platform")
	}
	cleanupSession(t, s, "future.jsonl", cwd, time.Now().Add(time.Hour), map[string]any{"name": "write", "arguments": map[string]any{"path": "preexisting.txt", "content": "created"}})
	files, _, err = s.sessionCleanupFiles("future.jsonl")
	if err != nil || len(files) != 0 {
		t.Fatal("accepted a file older than the session")
	}
}

func TestSessionCleanupConfirmStaleListRollbackAndSelectedDelete(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("real creation time required")
	}
	for _, permanent := range []bool{false, true} {
		t.Run(map[bool]string{true: "permanent", false: "trash"}[permanent], func(t *testing.T) {
			s := newTestServer(t)
			cwd := t.TempDir()
			os.Mkdir(filepath.Join(cwd, "outputs"), 0700)
			path := filepath.Join(cwd, "outputs", "drawing.svg")
			os.WriteFile(path, []byte("<svg/>"), 0600)
			keep := filepath.Join(cwd, "keep.txt")
			os.WriteFile(keep, []byte("keep"), 0600)
			cleanupSession(t, s, "clean.jsonl", cwd, time.Now().Add(-time.Minute), map[string]any{"name": "write", "arguments": map[string]any{"path": "outputs/drawing.svg", "content": "<svg/>"}})
			files, _, err := s.sessionCleanupFiles("clean.jsonl")
			if err != nil || len(files) != 1 {
				t.Fatal("missing owned file", err)
			}
			call := func(confirm bool) *httptest.ResponseRecorder {
				body, _ := json.Marshal(map[string]any{"id": "clean.jsonl", "files": files, "confirmFiles": confirm, "permanent": permanent})
				w := httptest.NewRecorder()
				s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(string(body))))
				return w
			}
			if w := call(false); w.Code != 400 {
				t.Fatal("accepted missing confirmation", w.Code)
			}
			os.WriteFile(path, []byte("later edit"), 0600)
			if w := call(true); w.Code != 409 {
				t.Fatal("accepted stale digest", w.Code, w.Body)
			}
			os.WriteFile(path, []byte("<svg/>"), 0600)
			if w := call(true); w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("selected file survived")
			}
			if b, err := os.ReadFile(keep); err != nil || string(b) != "keep" {
				t.Fatal("unselected file changed")
			}
			if _, err := os.Stat(filepath.Join(cwd, "outputs")); err != nil {
				t.Fatal("removed project folder")
			}
			stages, _ := filepath.Glob(filepath.Join(cwd, ".pi-session-cleanup-*"))
			if len(stages) != 0 {
				t.Fatal("staging leaked")
			}
		})
	}
	t.Run("database failure restores files", func(t *testing.T) {
		s := newTestServer(t)
		cwd := t.TempDir()
		path := filepath.Join(cwd, "owned.txt")
		os.WriteFile(path, []byte("owned"), 0600)
		cleanupSession(t, s, "rollback.jsonl", cwd, time.Now().Add(-time.Minute), map[string]any{"name": "write", "arguments": map[string]any{"path": "owned.txt", "content": "owned"}})
		files, _, _ := s.sessionCleanupFiles("rollback.jsonl")
		if len(files) != 1 {
			t.Fatal("missing candidate")
		}
		s.db.Close()
		body, _ := json.Marshal(map[string]any{"id": "rollback.jsonl", "files": files, "confirmFiles": true})
		w := httptest.NewRecorder()
		s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(string(body))))
		if w.Code != 500 {
			t.Fatal(w.Code, w.Body)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != "owned" {
			t.Fatal("rollback lost file")
		}
	})
}

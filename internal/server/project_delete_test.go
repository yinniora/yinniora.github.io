package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-web/internal/workers"
)

func deleteProjectRequest(s *Server, path string, files bool, name string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(map[string]any{"action": "delete", "path": path, "deleteFiles": files, "confirmation": name})
	w := httptest.NewRecorder()
	s.handleUpdateProject(w, httptest.NewRequest("POST", "/api/projects", strings.NewReader(string(b))))
	return w
}
func projectFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := newTestServer(t)
	project := filepath.Join(t.TempDir(), "project")
	os.MkdirAll(project, 0700)
	os.WriteFile(filepath.Join(project, "keep.txt"), []byte("project data"), 0600)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "p"), "first.jsonl", project)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "p"), "second.jsonl", project)
	s.syncProjectPrefs([]string{project})
	return s, project, filepath.Join(s.sessionsDir, "p", "first.jsonl")
}
func TestDeleteProjectKeepsFilesAndAllowsSessionRestore(t *testing.T) {
	s, project, session := projectFixture(t)
	before, _ := os.ReadFile(session)
	s.db.Exec(`INSERT INTO schedules(id,name,instructions,project_path,created_at,updated_at) VALUES('scheduled','demo','test',?,datetime('now'),datetime('now'))`, project)
	w := deleteProjectRequest(s, project, false, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "keep.txt")); string(data) != "project data" {
		t.Fatal("project files changed")
	}
	if data, _ := os.ReadFile(session); string(data) != string(before) {
		t.Fatal("session JSONL rewritten")
	}
	for i := 0; i < 2; i++ {
		w = httptest.NewRecorder()
		s.handleApiProjects(w, httptest.NewRequest("GET", "/api/projects", nil))
		if strings.Contains(w.Body.String(), project) {
			t.Fatal("deleted project rediscovered")
		}
	}
	var enabled int
	s.db.QueryRow(`SELECT enabled FROM schedules WHERE id='scheduled'`).Scan(&enabled)
	if enabled != 0 {
		t.Fatal("schedule not paused")
	}
	w = httptest.NewRecorder()
	s.handleTrash(w, httptest.NewRequest("POST", "/api/trash", strings.NewReader(`{"id":"first.jsonl","restore":true}`)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	visible, _ := s.loadSummaries()
	if len(visible) != 1 {
		t.Fatal("conversation could not be recovered")
	}
}
func TestDeleteProjectFilesRequiresNameAndIncludesSubprojects(t *testing.T) {
	s, project, _ := projectFixture(t)
	nested := filepath.Join(project, "child")
	os.Mkdir(nested, 0700)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "child"), "child.jsonl", nested)
	outside := t.TempDir()
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "outside"), "outside.jsonl", outside)
	s.syncProjectPrefs([]string{nested, outside})
	trash := filepath.Join(t.TempDir(), "project")
	calls := 0
	s.trashProjectFiles = func(_ context.Context, path string) (string, error) { calls++; return trash, os.Rename(path, trash) }
	if w := deleteProjectRequest(s, project, true, "wrong"); w.Code != 400 || calls != 0 {
		t.Fatal("folder deleted without confirmation")
	}
	if w := deleteProjectRequest(s, project, true, filepath.Base(project)); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if calls != 1 {
		t.Fatal("wrong filesystem operation count")
	}
	if _, err := os.Stat(project); !os.IsNotExist(err) {
		t.Fatal("folder not moved")
	}
	if b, _ := os.ReadFile(filepath.Join(trash, "keep.txt")); string(b) != "project data" {
		t.Fatal("Trash content damaged")
	}
	visible, _ := s.loadSummaries()
	if len(visible) != 1 || visible[0].Project != outside {
		t.Fatal("wrong project's history affected")
	}
}
func TestDeleteProjectRejectsBusyUnknownAndProtectedFolders(t *testing.T) {
	s, project, _ := projectFixture(t)
	s.chatSender = &fakeSender{status: workers.WorkerStatus{State: workers.WorkerStateRunning}}
	s.trashProjectFiles = func(context.Context, string) (string, error) {
		t.Fatal("filesystem touched for running project")
		return "", nil
	}
	if w := deleteProjectRequest(s, project, true, "project"); w.Code != 409 {
		t.Fatal(w.Code, w.Body)
	}
	if w := deleteProjectRequest(s, t.TempDir(), false, ""); w.Code != 404 {
		t.Fatal("unknown project accepted")
	}
	home, _ := os.UserHomeDir()
	s.syncProjectPrefs([]string{home})
	if w := deleteProjectRequest(s, home, true, filepath.Base(home)); w.Code != 400 {
		t.Fatal("account directory accepted")
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if os.Symlink(project, alias) == nil {
		s.syncProjectPrefs([]string{alias})
		if w := deleteProjectRequest(s, alias, true, "alias"); w.Code != 400 {
			t.Fatal("symlink root accepted")
		}
	}
}
func TestProjectFilesystemFailureRollsBackRecords(t *testing.T) {
	s, project, _ := projectFixture(t)
	s.trashProjectFiles = func(context.Context, string) (string, error) { return "", fmt.Errorf("permission denied") }
	if w := deleteProjectRequest(s, project, true, "project"); w.Code != 500 {
		t.Fatal(w.Code)
	}
	visible, _ := s.loadSummaries()
	if len(visible) != 2 {
		t.Fatal("history hidden after failed file operation")
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM project_prefs WHERE project_path=?`, project).Scan(&n)
	if n != 1 {
		t.Fatal("project removed after failure")
	}
}

func TestPausedProjectScheduleDoesNotRecreateDeletedProject(t *testing.T) {
	s, project, _ := projectFixture(t)
	s.db.Exec(`INSERT INTO schedules(id,name,instructions,project_path,created_at,updated_at) VALUES('auto','demo','test',?,datetime('now'),datetime('now'))`, project)
	sc, err := s.schedules.Get("auto")
	if err != nil {
		t.Fatal(err)
	}
	if w := deleteProjectRequest(s, project, false, ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if _, err := s.fireScheduleContext(context.Background(), sc, true); err == nil {
		t.Fatal("stale timer task was allowed to recreate the deleted project")
	}
	visible, _ := s.loadSummaries()
	if len(visible) != 0 {
		t.Fatal("project resurrected by a paused schedule")
	}
}

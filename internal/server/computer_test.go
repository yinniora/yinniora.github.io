package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

type fixtureComputerApprover struct {
	fakeSender
	requestSession string
	updatedSession string
}

func (f *fixtureComputerApprover) ComputerRequests(sessionID string) []workers.ComputerRequest {
	if sessionID == f.requestSession {
		return []workers.ComputerRequest{{ID: "pending-action"}}
	}
	return nil
}

func (f *fixtureComputerApprover) ReplyComputerRequest(sessionID, requestID string, allow bool) error {
	if sessionID != f.requestSession || requestID != "pending-action" {
		return errors.New("approval expired")
	}
	f.requestSession = ""
	return nil
}

func (f *fixtureComputerApprover) ApplyComputerPolicy(sessionID string) {
	f.updatedSession = sessionID
}

func TestComputerPermissionsAreSessionScoped(t *testing.T) {
	root := t.TempDir()
	db, err := initDB(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	writeSessionFile(t, root, "project", "first.jsonl")
	writeSessionFile(t, root, "project", "second.jsonl")
	manager := &fixtureComputerApprover{requestSession: "second.jsonl"}
	s := &Server{db: db, sessionsDir: root, cache: sessions.NewCache(), chatSender: manager, agentDir: root}
	post := func(id, body string, want int) {
		t.Helper()
		recorder := httptest.NewRecorder()
		s.handleComputerUse(recorder, httptest.NewRequest(http.MethodPost, "/api/computer-use?id="+id, strings.NewReader(body)))
		if recorder.Code != want {
			t.Fatalf("%s: status %d, want %d; %s", id, recorder.Code, want, recorder.Body)
		}
	}
	post("first.jsonl", `{"action":"mode","mode":"allow"}`, 200)
	if s.ComputerMode("first.jsonl") != "allow" || s.ComputerMode("second.jsonl") != "ask" || manager.updatedSession != "first.jsonl" {
		t.Fatal("changing one permission affected a different session")
	}
	post("first.jsonl", `{"action":"answer","requestID":"pending-action","allow":true}`, 409)
	post("second.jsonl", `{"action":"answer","requestID":"pending-action"}`, 400)
	post("second.jsonl", `{"action":"answer","requestID":"pending-action","allow":true}`, 200)
	post("second.jsonl", `{"action":"answer","requestID":"pending-action","allow":true}`, 409)
	if s.ComputerMode("second.jsonl") != "ask" {
		t.Fatal("one approval persisted as a session-wide grant")
	}
	if _, err := db.Exec(`INSERT INTO session_trash (session_id, deleted_at) VALUES ('first.jsonl', '2026-01-01')`); err != nil {
		t.Fatal(err)
	}
	post("first.jsonl", `{"action":"mode","mode":"off"}`, 410)
}

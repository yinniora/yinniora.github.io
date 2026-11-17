package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pi-web/internal/schedules"
	"pi-web/internal/workers"
)

func withinProject(path, parent string) bool {
	rel, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Compare directory identities as well as spelling: macOS paths can alias the
// same folder through case variants, volume aliases or parent symlinks.
func filesystemWithin(path, parent string) bool {
	root, err := os.Stat(parent)
	if err == nil {
		for cursor := filepath.Clean(path); ; cursor = filepath.Dir(cursor) {
			if info, e := os.Stat(cursor); e == nil && os.SameFile(info, root) {
				return true
			}
			if cursor == filepath.Dir(cursor) {
				break
			}
		}
	}
	return withinProject(path, parent)
}

// File deletion is deliberately a move to the operating system's Trash. Refuse
// system/account roots and folders containing Pi's credentials or running code.
func (s *Server) projectFilesPath(path string) (string, error) {
	clean, err := normalizeProjectPath(path)
	if err != nil {
		return "", err
	}
	if path != clean {
		return "", fmt.Errorf("use a normalized absolute project path")
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(clean)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("choose a real project directory")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if real, e := filepath.EvalSymlinks(home); e == nil {
		home = real
	}
	protected := []string{home, s.agentDir, filepath.Join(home, ".ssh"), filepath.Join(home, ".codex"), filepath.Join(home, ".pi"), filepath.Join(home, ".config"), filepath.Join(home, ".local"), filepath.Join(home, "Library"), filepath.Join(home, "Applications")}
	if executable, err := os.Executable(); err == nil {
		protected = append(protected, executable)
	}
	protected = append(protected, filepath.SplitList(os.Getenv("PI_WEB_PROTECTED_PATHS"))...)
	for _, p := range protected {
		if p == "" {
			continue
		}
		if real, e := filepath.EvalSymlinks(p); e == nil {
			p = real
		}
		if filesystemWithin(p, resolved) || (p != home && filesystemWithin(resolved, p)) {
			return "", fmt.Errorf("directory contains protected account or Pi data")
		}
	}
	for _, root := range []string{"/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/dev", "/private/etc", "/private/var/db"} {
		if filesystemWithin(resolved, root) {
			return "", fmt.Errorf("system directories cannot be deleted")
		}
	}
	for _, root := range []string{string(filepath.Separator), filepath.Dir(home), "/Volumes", "/private", "/private/var", "/private/tmp"} {
		if rootInfo, e := os.Stat(root); e == nil && os.SameFile(rootInfo, info) {
			return "", fmt.Errorf("root directories cannot be deleted")
		}
	}

	for _, name := range []string{"Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies"} {
		if bucket, e := os.Stat(filepath.Join(home, name)); e == nil && os.SameFile(bucket, info) {
			return "", fmt.Errorf("account folders cannot be deleted")
		}
	}
	return clean, nil
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request, path string, deleteFiles bool, confirmation string) {
	s.sessionManagementMu.Lock()
	defer s.sessionManagementMu.Unlock()
	normalized, err := normalizeProjectPath(path)
	if err != nil {
		writeJSONError(w, 400, "invalid project path")
		return
	}
	all, err := s.cache.LoadAll(s.sessionsDir)
	if err != nil {
		writeJSONError(w, 500, "cannot read project sessions")
		return
	}
	var known int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM project_prefs WHERE project_path=?`, path).Scan(&known)
	for _, v := range all {
		if v.Project == path {
			known = 1
		}
	}
	if known == 0 {
		writeJSONError(w, 404, "project not found")
		return
	}
	filePath := ""
	if deleteFiles {
		if confirmation != filepath.Base(normalized) {
			writeJSONError(w, 400, "project name confirmation does not match")
			return
		}
		if s.trashProjectFiles == nil {
			writeJSONError(w, 503, "file deletion is unavailable")
			return
		}
		filePath, err = s.projectFilesPath(path)
		if err != nil {
			writeJSONError(w, 400, "this directory cannot be deleted; remove the project without deleting its files")
			return
		}
	}
	canonicalRoot := normalized
	if real, e := filepath.EvalSymlinks(normalized); e == nil {
		canonicalRoot = real
	}
	matches := func(p string) bool {
		if p == path {
			return true
		}
		if !deleteFiles || p == "" {
			return false
		}
		if real, e := filepath.EvalSymlinks(p); e == nil {
			return filesystemWithin(real, canonicalRoot)
		}
		return withinProject(p, normalized)
	}
	ids := []string{}
	for _, v := range all {
		if !matches(v.Project) {
			continue
		}
		if s.readSessionStatus(v.ID) != nil || (s.chatSender != nil && s.chatSender.Status(v.ID).State == workers.WorkerStateRunning) {
			writeJSONError(w, 409, "stop the project's running tasks before deletion")
			return
		}
		ids = append(ids, v.ID)
	}
	rollbacks := []func(){}
	committed := false
	defer func() {
		if !committed {
			for _, rollback := range rollbacks {
				rollback()
			}
		}
	}()
	if s.chatSender != nil && len(ids) > 0 {
		retirer, ok := s.chatSender.(interface{ RetireIdle(string) (func(), error) })
		if !ok {
			writeJSONError(w, 503, "worker retirement unavailable")
			return
		}
		for _, id := range ids {
			rollback, err := retirer.RetireIdle(id)
			if err != nil {
				writeJSONError(w, 409, "stop the project's running tasks before deletion")
				return
			}
			rollbacks = append(rollbacks, rollback)
		}
	}
	paths := []string{path}
	if deleteFiles {
		rows, err := s.db.Query(`SELECT project_path FROM project_prefs`)
		if err != nil {
			writeJSONError(w, 500, "cannot read project settings")
			return
		}
		for rows.Next() {
			var p string
			if rows.Scan(&p) == nil && p != path && matches(p) {
				paths = append(paths, p)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			writeJSONError(w, 500, "cannot read project settings")
			return
		}
	}
	// Prevent a deleted project from being immediately recreated by automation.
	scheduleIDs := []string{}
	scheduleRows, err := s.db.Query(`SELECT id, project_path FROM schedules WHERE enabled=1`)
	if err != nil {
		writeJSONError(w, 500, "cannot read project schedules")
		return
	}
	for scheduleRows.Next() {
		var id, p string
		if scheduleRows.Scan(&id, &p) == nil && matches(p) {
			scheduleIDs = append(scheduleIDs, id)
		}
	}
	err = scheduleRows.Err()
	scheduleRows.Close()
	if err != nil {
		writeJSONError(w, 500, "cannot read project schedules")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		writeJSONError(w, 500, "cannot prepare project deletion")
		return
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err = tx.Exec(`INSERT INTO session_trash(session_id,deleted_at) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`, id, s.now().UTC().Format(time.RFC3339)); err != nil {
			writeJSONError(w, 500, "cannot move project sessions to Trash")
			return
		}
	}
	for _, p := range paths {
		if _, err = tx.Exec(`DELETE FROM project_prefs WHERE project_path=?`, p); err != nil {
			writeJSONError(w, 500, "cannot remove project settings")
			return
		}
	}
	for _, id := range scheduleIDs {
		if _, err = tx.Exec(`UPDATE schedules SET enabled=0,updated_at=? WHERE id=?`, s.now(), id); err != nil {
			writeJSONError(w, 500, "cannot pause project schedules")
			return
		}
	}
	trashPath := ""
	if deleteFiles {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		trashPath, err = s.trashProjectFiles(ctx, filePath)
		if err != nil || !filepath.IsAbs(trashPath) {
			writeJSONError(w, 500, "could not move the project folder to Mac Trash; project records were kept")
			return
		}
	}
	if err = tx.Commit(); err != nil {
		if trashPath != "" {
			if restoreErr := os.Rename(trashPath, filePath); restoreErr != nil {
				writeJSONError(w, 500, "database update failed; recover the project folder from Mac Trash")
				return
			}
		}
		writeJSONError(w, 500, "cannot commit project deletion")
		return
	}
	committed = true
	for _, id := range scheduleIDs {
		s.notifySchedulesChanged("paused", schedules.Schedule{ID: id})
	}
	s.broadcast("__all__", "new-session")
	for _, id := range ids {
		s.broadcast(id, "reload")
	}
	writeJSON(w, 200, map[string]any{"ok": true, "path": path, "filesTrashed": deleteFiles, "sessionsTrashed": len(ids)})
}

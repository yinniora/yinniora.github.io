package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

type sessionFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
	info   fs.FileInfo
}

func cleanupRelativePath(cwd, name string) string {
	if filepath.IsAbs(name) {
		var err error
		name, err = filepath.Rel(cwd, name)
		if err != nil {
			return ""
		}
	}
	name = filepath.ToSlash(name)
	if !fs.ValidPath(name) || name == "." || strings.Contains(name, "\\") {
		return ""
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return ""
		}
		switch strings.ToLower(part) {
		case "node_modules", "vendor", "private", "secrets", "auth.json", "credentials.json", "models.json":
			return ""
		}
	}
	return name
}

// No symlink, including an in-root alias: cleanup operates on named real files.
func cleanupFileInfo(root *os.Root, name string) (fs.FileInfo, error) {
	parts := strings.Split(name, "/")
	var info fs.FileInfo
	for i := range parts {
		var err error
		info, err = root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symlink")
		}
	}
	if !info.Mode().IsRegular() || info.Size() > 16<<20 {
		return nil, fmt.Errorf("unsupported file")
	}
	return info, nil
}

func cleanupDigest(root *os.Root, name string) (string, error) {
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(f, (16<<20)+1))
	if err != nil || n > 16<<20 {
		return "", fmt.Errorf("cannot verify file")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func successfulWrites(session sessions.Session) map[string]string {
	results := map[string]bool{}
	for _, entry := range session.Entries {
		msg, _ := entry["message"].(map[string]any)
		if msg["role"] == "toolResult" {
			id, _ := msg["toolCallId"].(string)
			results[id] = msg["isError"] != true
		}
	}
	out := map[string]string{}
	for _, entry := range session.Entries {
		msg, _ := entry["message"].(map[string]any)
		if msg["role"] != "assistant" {
			continue
		}
		blocks, _ := msg["content"].([]any)
		for _, value := range blocks {
			call, _ := value.(map[string]any)
			if call["type"] != "toolCall" || call["name"] == "read" {
				continue
			}
			args, _ := call["arguments"].(map[string]any)
			name, _ := args["path"].(string)
			if name == "" {
				name, _ = args["file_path"].(string)
			}
			if name == "" {
				continue
			}
			delete(out, name)
			id, _ := call["id"].(string)
			content, ok := args["content"].(string)
			if call["name"] == "write" && ok && len(content) <= 16<<20 && results[id] {
				sum := sha256.Sum256([]byte(content))
				out[name] = hex.EncodeToString(sum[:])
			}
		}
	}
	return out
}

// A recent mtime alone is never ownership evidence. Require a successful write,
// matching bytes, actual birth time after this session began, and no reference
// from any other session (including Trash). This intentionally keeps ambiguous
// shell outputs and edited/shared files instead of guessing.
func (s *Server) sessionCleanupFiles(id string) ([]sessionFile, string, error) {
	resolved, cwd, err := s.resolveSessionCwd(id)
	if err != nil {
		return nil, "", err
	}
	out := []sessionFile{}
	startText, _ := resolved.Session.Header["timestamp"].(string)
	start, err := time.Parse(time.RFC3339Nano, startText)
	if err != nil {
		return out, cwd, nil
	}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return out, cwd, nil
	}
	defer root.Close()
	candidates := map[string]string{}
	for name, digest := range successfulWrites(resolved.Session) {
		if rel := cleanupRelativePath(cwd, name); rel != "" {
			candidates[rel] = digest
		}
	}
	if len(candidates) == 0 {
		return out, cwd, nil
	}
	all, err := s.cache.LoadAll(s.sessionsDir)
	if err != nil {
		return nil, "", err
	}
	if len(all) > 2000 {
		return nil, "", fmt.Errorf("too many sessions to verify file ownership")
	}
	for _, other := range all {
		if other.ID == resolved.Session.ID {
			continue
		}
		session, err := s.cache.Resolve(s.sessionsDir, other.ID)
		if err != nil {
			return nil, "", err
		}
		for _, entry := range session.Session.Entries {
			msg, _ := entry["message"].(map[string]any)
			blocks, _ := msg["content"].([]any)
			for _, value := range blocks {
				block, _ := value.(map[string]any)
				args, _ := block["arguments"].(map[string]any)
				for _, key := range []string{"path", "file_path"} {
					name, _ := args[key].(string)
					if name == "" {
						continue
					}
					if !filepath.IsAbs(name) {
						name = filepath.Join(other.Project, name)
					}
					full, err := filepath.EvalSymlinks(name)
					if err != nil {
						continue
					}
					for candidate := range candidates {
						path, err := filepath.EvalSymlinks(filepath.Join(cwd, candidate))
						if err == nil && path == full {
							delete(candidates, candidate)
						}
					}
				}
			}
		}
	}
	for name, expected := range candidates {
		info, err := cleanupFileInfo(root, name)
		if err != nil {
			continue
		}
		birth := cleanupBirthTime(info)
		if birth.IsZero() || birth.Before(start) || info.ModTime().Before(start) {
			continue
		}
		actual, err := cleanupDigest(root, name)
		if err != nil || actual != expected {
			continue
		}
		out = append(out, sessionFile{Path: name, Size: info.Size(), Digest: actual, info: info})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, cwd, nil
}

func (s *Server) handleSessionFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	files, _, err := s.sessionCleanupFiles(r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"files": files})
}

// Stage atomically within os.Root before deleting anything, then recheck inode
// and digest. If another process swaps a file, restore it and reject the whole
// operation. Never recursively remove a directory supplied by a client.
func (s *Server) stageSessionFiles(id string, selected []sessionFile) (finish func(bool) error, err error) {
	if len(selected) == 0 {
		return func(bool) error { return nil }, nil
	}
	if len(selected) > 100 {
		return nil, fmt.Errorf("select at most 100 files")
	}
	files, cwd, err := s.sessionCleanupFiles(id)
	if err != nil {
		return nil, err
	}
	allowed := map[string]sessionFile{}
	for _, file := range files {
		allowed[file.Path] = file
	}
	for _, file := range selected {
		v, ok := allowed[file.Path]
		if !ok || v.Digest != file.Digest {
			return nil, fmt.Errorf("file ownership or content changed; reload the list")
		}
	}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return nil, err
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		root.Close()
		return nil, err
	}
	stage := ".pi-session-cleanup-" + hex.EncodeToString(random[:])
	if err = root.Mkdir(stage, 0700); err != nil {
		root.Close()
		return nil, err
	}
	moved := []string{}
	finish = func(commit bool) error {
		defer root.Close()
		var first error
		for _, name := range moved {
			staged := stage + "/" + name
			var err error
			if commit {
				err = root.Remove(staged)
			} else {
				if _, err = root.Lstat(name); !os.IsNotExist(err) {
					if first == nil {
						first = fmt.Errorf("file changed during rollback; recover files from %s", stage)
					}
					continue
				}
				err = root.Rename(staged, name)
			}
			if err != nil && first == nil {
				first = err
			}
		}
		// Empty staging subdirectories only; never RemoveAll on user paths.
		for i := len(moved) - 1; i >= 0; i-- {
			for dir := filepath.ToSlash(filepath.Dir(moved[i])); dir != "."; dir = filepath.ToSlash(filepath.Dir(dir)) {
				_ = root.Remove(stage + "/" + dir)
			}
		}
		if err := root.Remove(stage); err != nil && first == nil {
			first = err
		}
		return first
	}
	seen := map[string]bool{}
	for _, file := range selected {
		if seen[file.Path] {
			continue
		}
		seen[file.Path] = true
		parts := strings.Split(file.Path, "/")
		for i := 1; i < len(parts); i++ {
			if e := root.Mkdir(stage+"/"+strings.Join(parts[:i], "/"), 0700); e != nil && !os.IsExist(e) {
				_ = finish(false)
				return nil, e
			}
		}
		staged := stage + "/" + file.Path
		if err = root.Rename(file.Path, staged); err != nil {
			_ = finish(false)
			return nil, err
		}
		moved = append(moved, file.Path)
		info, e := cleanupFileInfo(root, staged)
		digest, de := cleanupDigest(root, staged)
		original := allowed[file.Path]
		if e != nil || de != nil || !os.SameFile(info, original.info) || digest != file.Digest {
			_ = finish(false)
			return nil, fmt.Errorf("file changed during cleanup; reload the list")
		}
	}
	return finish, nil
}

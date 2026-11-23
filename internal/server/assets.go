package server

import (
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

type workspaceAsset struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Kind     string    `json:"kind"`
	MIME     string    `json:"mime"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func assetType(name string) (string, string) {
	ext := strings.ToLower(path.Ext(name))
	kind := "file"
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp":
		kind = "image"
	case ".svg":
		return "svg", "image/svg+xml"
	case ".mp4", ".m4v", ".mov", ".webm":
		kind = "video"
	case ".mp3", ".m4a", ".wav", ".ogg":
		kind = "audio"
	case ".pdf":
		return "pdf", "application/pdf"
	case ".md", ".txt", ".csv", ".json", ".html", ".htm", ".zip", ".docx", ".xlsx", ".pptx":
	default:
		return "", ""
	}
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return kind, contentType
}

func allowedAssetPath(name string) bool {
	if !fs.ValidPath(name) || name == "." || strings.Contains(name, "\\") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
		switch strings.ToLower(part) {
		case "node_modules", "vendor", "private", "secrets", "auth.json", "credentials.json", "models.json":
			return false
		}
	}
	kind, _ := assetType(name)
	return kind != ""
}

func referencedAssets(session *sessions.Session, cwd string) (refs, outputs map[string]bool) {
	refs = make(map[string]bool)
	outputs = make(map[string]bool)
	completed := make(map[string]bool)
	for _, entry := range session.Entries {
		message, _ := entry["message"].(map[string]any)
		if id, _ := message["toolCallId"].(string); id != "" && message["role"] == "toolResult" {
			completed[id] = message["isError"] != true
		}
	}
	for _, entry := range session.Entries {
		message, _ := entry["message"].(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		blocks, _ := message["content"].([]any)
		for _, value := range blocks {
			block, _ := value.(map[string]any)
			if block["type"] != "toolCall" {
				continue
			}
			args, _ := block["arguments"].(map[string]any)
			filePath, _ := args["path"].(string)
			if filePath == "" {
				filePath, _ = args["file_path"].(string)
			}
			if filePath == "" {
				continue
			}
			if filepath.IsAbs(filePath) {
				var err error
				filePath, err = filepath.Rel(cwd, filePath)
				if err != nil {
					continue
				}
			}
			filePath = filepath.ToSlash(filepath.Clean(filePath))
			if allowedAssetPath(filePath) {
				refs[filePath] = true
				id, _ := block["id"].(string)
				if completed[id] && (block["name"] == "write" || block["name"] == "edit") {
					outputs[filePath] = true
				}
			}
		}
	}
	return refs, outputs
}

func eligibleAsset(name string, info fs.FileInfo, since time.Time, refs map[string]bool) bool {
	return allowedAssetPath(name) && info.Mode().IsRegular() && info.Size() <= 1<<30 &&
		(refs[name] || (!since.IsZero() && !info.ModTime().Before(since.Add(-2*time.Second))))
}

func assetFileInfo(root *os.Root, name string) (fs.FileInfo, error) {
	parts := strings.Split(name, "/")
	parent := ""
	for _, part := range parts[:len(parts)-1] {
		parent = path.Join(parent, part)
		info, err := root.Lstat(parent)
		if err != nil || !info.IsDir() {
			return nil, fs.ErrNotExist
		}
	}
	return root.Lstat(name)
}

func (s *Server) handleAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	resolved, cwd, err := s.resolveSessionCwd(r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	out := []workspaceAsset{}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		writeJSON(w, 200, map[string]any{"assets": out})
		return
	}
	defer root.Close()
	stamp, _ := resolved.Session.Header["timestamp"].(string)
	since, _ := time.Parse(time.RFC3339Nano, stamp)
	refs, outputs := referencedAssets(&resolved.Session, cwd)
	add := func(name string, info fs.FileInfo) {
		if !eligibleAsset(name, info, since, refs) {
			return
		}
		kind, contentType := assetType(name)
		out = append(out, workspaceAsset{Path: name, Name: path.Base(name), Kind: kind,
			MIME: contentType, Size: info.Size(), Modified: info.ModTime()})
	}
	query := r.URL.Query()
	if query.Get("scope") == "session" {
		// An explicit reply link can request metadata for that exact file, using
		// the same workspace and file eligibility checks as a download.
		links := query["link"]
		for _, name := range links[:min(len(links), 40)] {
			if allowedAssetPath(name) {
				outputs[name] = true
			}
		}
		for name := range outputs {
			if info, err := assetFileInfo(root, name); err == nil {
				add(name, info)
			}
		}
	} else {
		visited := 0
		_ = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
			visited++
			if visited > 10000 {
				return fs.SkipAll
			}
			if walkErr != nil {
				return nil
			}
			if entry.IsDir() {
				if name != "." && (strings.HasPrefix(entry.Name(), ".") || strings.Count(name, "/") >= 5) {
					return fs.SkipDir
				}
				switch strings.ToLower(entry.Name()) {
				case "node_modules", "vendor", "private", "secrets", "dist", "build":
					return fs.SkipDir
				}
				return nil
			}
			if info, err := entry.Info(); err == nil {
				add(name, info)
			}
			return nil
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Modified.Equal(out[j].Modified) {
			return out[i].Path < out[j].Path
		}
		return out[i].Modified.After(out[j].Modified)
	})
	if len(out) > 100 {
		out = out[:100]
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, 200, map[string]any{"assets": out})
}

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	name := r.URL.Query().Get("path")
	if !allowedAssetPath(name) {
		writeJSONError(w, 400, "invalid asset path")
		return
	}
	resolved, cwd, err := s.resolveSessionCwd(r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	// os.Root also enforces containment during open, including symlink races.
	root, err := os.OpenRoot(cwd)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	expected, err := assetFileInfo(root, name)
	if err != nil || !expected.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	file, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	stamp, _ := resolved.Session.Header["timestamp"].(string)
	since, _ := time.Parse(time.RFC3339Nano, stamp)
	refs, _ := referencedAssets(&resolved.Session, cwd)
	if err != nil || !os.SameFile(expected, info) || !eligibleAsset(name, info, since, refs) {
		http.NotFound(w, r)
		return
	}
	kind, contentType := assetType(name)
	disposition := "attachment"
	if r.URL.Query().Get("inline") == "1" && (kind == "image" || kind == "video" || kind == "audio" || kind == "pdf") {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition+"; filename*=UTF-8''"+url.PathEscape(path.Base(name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

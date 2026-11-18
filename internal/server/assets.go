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

func referencedAssets(session *sessions.Session, cwd string) map[string]bool {
	refs := make(map[string]bool)
	for _, entry := range session.Entries {
		message, _ := entry["message"].(map[string]any)
		blocks, _ := message["content"].([]any)
		for _, value := range blocks {
			block, _ := value.(map[string]any)
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
			}
		}
	}
	return refs
}

func eligibleAsset(name string, info fs.FileInfo, since time.Time, refs map[string]bool) bool {
	return allowedAssetPath(name) && info.Mode().IsRegular() && info.Size() <= 1<<30 &&
		(refs[name] || (!since.IsZero() && !info.ModTime().Before(since.Add(-2*time.Second))))
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
	refs := referencedAssets(&resolved.Session, cwd)
	sessionOnly := r.URL.Query().Get("scope") == "session"
	if sessionOnly && len(refs) == 0 {
		writeJSON(w, 200, map[string]any{"assets": out})
		return
	}
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
		if entry.Type()&os.ModeSymlink != 0 || !allowedAssetPath(name) ||
			(sessionOnly && !refs[name]) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !eligibleAsset(name, info, since, refs) {
			return nil
		}
		kind, contentType := assetType(name)
		out = append(out, workspaceAsset{Path: name, Name: path.Base(name), Kind: kind,
			MIME: contentType, Size: info.Size(), Modified: info.ModTime()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].Modified.Equal(out[j].Modified) {
			return out[i].Path < out[j].Path
		}
		return out[i].Modified.After(out[j].Modified)
	})
	if len(out) > 100 {
		out = out[:100]
	}
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
	file, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	stamp, _ := resolved.Session.Header["timestamp"].(string)
	since, _ := time.Parse(time.RFC3339Nano, stamp)
	if err != nil || !eligibleAsset(name, info, since, referencedAssets(&resolved.Session, cwd)) {
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

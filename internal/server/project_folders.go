package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var errFolderScope = errors.New("folder is outside the account home")

type projectFolder struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type projectFolderListing struct {
	Root      string          `json:"root"`
	Path      string          `json:"path"`
	Parent    string          `json:"parent"`
	Folders   []projectFolder `json:"folders"`
	Truncated bool            `json:"truncated"`
}

// A read-only picker for the Mac account's folders. OpenRoot prevents a symlink
// swap from escaping that scope; no file contents or credentials are returned.
func listProjectFolders(home, requested string) (*projectFolderListing, error) {
	home = filepath.Clean(home)
	path := strings.TrimSpace(requested)
	if path == "" || path == "~" {
		path = home
	} else if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		return nil, errFolderScope
	}
	path = filepath.Clean(path)
	relative, err := filepath.Rel(home, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return nil, errFolderScope
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := root.Open(relative)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(4097)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	out := &projectFolderListing{Root: home, Path: path, Folders: []projectFolder{}, Truncated: len(entries) > 4096}
	if path != home {
		out.Parent = filepath.Dir(path)
	}
	if len(entries) > 4096 {
		entries = entries[:4096]
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		out.Folders = append(out.Folders, projectFolder{Name: entry.Name(), Path: filepath.Join(path, entry.Name())})
	}
	sort.Slice(out.Folders, func(i, j int) bool { return out.Folders[i].Name < out.Folders[j].Name })
	if len(out.Folders) > 400 {
		out.Folders = out.Folders[:400]
		out.Truncated = true
	}
	return out, nil
}

func (s *Server) handleProjectFolders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		writeJSONError(w, 500, "home folder unavailable")
		return
	}
	if len(r.URL.Query().Get("path")) > 4096 {
		writeJSONError(w, 400, "invalid folder path")
		return
	}
	folders, err := listProjectFolders(home, r.URL.Query().Get("path"))
	if err != nil {
		writeJSONError(w, 403, "This folder cannot be browsed. Choose a folder inside the Mac account home, or enter its Mac path manually.")
		return
	}
	writeJSON(w, 200, folders)
}

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

func projectFolderPath(home, requested string) (path, relative string, err error) {
	home = filepath.Clean(home)
	path = strings.TrimSpace(requested)
	if path == "" || path == "~" {
		path = home
	} else if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		return "", "", errFolderScope
	}
	path = filepath.Clean(path)
	relative, err = filepath.Rel(home, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", "", errFolderScope
	}
	return path, relative, nil
}

// OpenRoot prevents a symlink swap from escaping the Mac account's home.
func listProjectFolders(home, requested string) (*projectFolderListing, error) {
	home = filepath.Clean(home)
	path, relative, err := projectFolderPath(home, requested)
	if err != nil {
		return nil, err
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

func createProjectFolder(home, parent, name string) (projectFolder, error) {
	path, relative, err := projectFolderPath(home, parent)
	if err != nil {
		return projectFolder{}, err
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return projectFolder{}, err
	}
	defer root.Close()
	dir, err := root.OpenRoot(relative)
	if err != nil {
		return projectFolder{}, err
	}
	defer dir.Close()
	if err := dir.Mkdir(name, 0755); err != nil {
		return projectFolder{}, err
	}
	return projectFolder{Name: name, Path: filepath.Join(path, name)}, nil
}

func (s *Server) handleProjectFolders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		writeJSONError(w, 500, "home folder unavailable")
		return
	}
	if r.Method == http.MethodPost {
		var input struct{ Parent, Name string }
		if !decodeJSONBody(w, r, &input) {
			return
		}
		name := strings.TrimSpace(input.Name)
		if len(input.Parent) > 4096 || name == "" || len(name) > 255 || strings.HasPrefix(name, ".") ||
			strings.ContainsAny(name, "/\\:\x00\r\n") {
			writeJSONError(w, 400, "invalid folder name")
			return
		}
		folder, err := createProjectFolder(home, input.Parent, name)
		if errors.Is(err, os.ErrExist) {
			writeJSONError(w, 409, "folder already exists")
		} else if err != nil {
			writeJSONError(w, 403, "cannot create a folder here")
		} else {
			writeJSON(w, 201, folder)
		}
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

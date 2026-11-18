package server

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"pi-web/internal/agentdir"
	"pi-web/internal/chat"
)

func (s *Server) saveChatFiles(sessionID string, req *chat.Request) (string, error) {
	if len(req.Files) == 0 {
		return "", nil
	}
	dir := filepath.Join(agentdir.WebDir(s.agentDir), "uploads", fmt.Sprintf("%x", sha256.Sum256([]byte(sessionID))))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	batch, err := os.MkdirTemp(dir, "attachment-")
	if err != nil {
		return "", err
	}
	var names strings.Builder
	names.WriteString("\n\nFiles attached by the user (stored on the computer):")
	for i, file := range req.Files {
		name := strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune(".-_ ", r) {
				return r
			}
			return '_'
		}, filepath.Base(strings.ReplaceAll(file.Name, "\\", "/")))
		if runes := []rune(name); len(runes) > 60 {
			name = string(runes[len(runes)-60:])
		}
		path := filepath.Join(batch, fmt.Sprintf("%d-%s", i+1, name))
		if err := os.WriteFile(path, file.Data, 0600); err != nil {
			_ = os.RemoveAll(batch)
			return "", err
		}
		fmt.Fprintf(&names, "\n- %q", path)
	}
	req.Message = strings.TrimSpace(req.Message + names.String())
	req.Files = nil
	return batch, nil
}

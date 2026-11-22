package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"pi-web/internal/agentdir"
)

func stateFileName(development bool) string {
	if development {
		return "pi-web-state-dev.json"
	}
	return "pi-web-state.json"
}

// writeStateFile returns an open file handle that the caller must retain for
// the process lifetime. Closing it releases the instance lock.
func writeStateFile(agentDir string, development bool, host, port string, tailscale bool, tailscaleURL string) (string, *os.File, error) {
	if err := agentdir.PrepareWeb(agentDir); err != nil {
		return "", nil, err
	}
	path := filepath.Join(agentdir.WebDir(agentDir), stateFileName(development))

	// Only the regular server owns the legacy state path used by extensions.
	// Development mode gets an independent state file and lock.
	if !development {
		oldPath := filepath.Join(agentDir, "pi-web-state.json")
		old, err := agentdir.OpenPrivateFile(oldPath, false)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", nil, err
		}
		if err == nil {
			_ = old.Close()
			if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
				_ = os.Rename(oldPath, path)
			}
		}
	}

	f, err := agentdir.OpenPrivateFile(path, true)
	if err != nil {
		return "", nil, err
	}
	if err := lockStateFile(f); err != nil {
		_ = f.Close()
		return "", nil, err
	}
	data, err := json.Marshal(map[string]any{
		"pid":          os.Getpid(),
		"port":         port,
		"host":         host,
		"development":  development,
		"tailscale":    tailscale,
		"tailscaleUrl": tailscaleURL,
		"startedAt":    time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		_ = f.Close()
		return "", nil, err
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return "", nil, err
	}
	if _, err := f.WriteAt(data, 0); err != nil {
		_ = f.Close()
		return "", nil, err
	}
	return path, f, nil
}

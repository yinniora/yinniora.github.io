// Package picmd finds the Pi CLI for local and packaged hosts.
package picmd

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// Command uses the desktop package's private runtime when configured. Pi runs
// as the direct child process so cancellation also works on Windows, where the
// npm launcher is a batch file.
func Command(ctx context.Context, dir string, args ...string) *exec.Cmd {
	node := os.Getenv("PI_WEB_PI_NODE")
	script := os.Getenv("PI_WEB_PI_SCRIPT")
	var cmd *exec.Cmd
	if node == "" && script == "" {
		cmd = exec.CommandContext(ctx, "pi", args...)
	} else if !filepath.IsAbs(node) || !filepath.IsAbs(script) {
		return &exec.Cmd{Err: errors.New("packaged Pi runtime paths must be absolute")}
	} else {
		cmd = exec.CommandContext(ctx, node, append([]string{script}, args...)...)
	}
	cmd.Dir = dir
	// Pi uses the local web token for its bundled control skills. The relay
	// server credentials belong to the backend. Disable Pi's install telemetry
	// for YuGo-managed launches without changing the user's terminal settings.
	cmd.Env = slices.DeleteFunc(cmd.Environ(), func(entry string) bool {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "PI_WEB_RELAY_HOST_TOKEN", "PI_WEB_REMOTE_TURN_SECRET", "PI_WEB_RELAY_CLIENT_SECRET", "PI_TELEMETRY":
			return true
		default:
			return false
		}
	})
	cmd.Env = append(cmd.Env, "PI_TELEMETRY=0")
	return cmd
}

// Package picmd finds the Pi CLI for local and packaged hosts.
package picmd

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// Command uses the desktop package's private runtime when configured. Pi runs
// as the direct child process so cancellation also works on Windows, where the
// npm launcher is a batch file.
func Command(ctx context.Context, args ...string) *exec.Cmd {
	node := os.Getenv("PI_WEB_PI_NODE")
	script := os.Getenv("PI_WEB_PI_SCRIPT")
	if node == "" && script == "" {
		return exec.CommandContext(ctx, "pi", args...)
	}
	if !filepath.IsAbs(node) || !filepath.IsAbs(script) {
		return &exec.Cmd{Err: errors.New("packaged Pi runtime paths must be absolute")}
	}
	return exec.CommandContext(ctx, node, append([]string{script}, args...)...)
}

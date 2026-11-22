//go:build unix

package agentdir

import (
	"fmt"
	"os"
	"syscall"
)

func protectFileMode(f *os.File, info os.FileInfo, mode os.FileMode) error {
	stat := info.Sys().(*syscall.Stat_t)
	if int(stat.Uid) != os.Geteuid() || (!info.IsDir() && stat.Nlink != 1) {
		return fmt.Errorf("expected a user-owned private state path at %s", f.Name())
	}
	if info.Mode().Perm() == mode {
		return nil
	}
	return f.Chmod(mode)
}

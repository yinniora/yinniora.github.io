package agentdir

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ProtectDefault keeps session and credential files in the conventional Pi
// directory private. Custom paths and symlinked installations may deliberately
// share Pi state and keep their chosen directory policy.
func ProtectDefault(path string) error {
	home, err := os.UserHomeDir()
	if err != nil || filepath.Clean(path) != filepath.Join(home, ".pi", "agent") {
		return nil
	}
	for _, dir := range []string{filepath.Dir(path), path} {
		info, err := os.Lstat(dir)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
	}
	return protectDirectory(path)
}

// PrepareWeb secures YuGo's own state directory, including existing installs.
func PrepareWeb(agentPath string) error {
	path := WebDir(agentPath)
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return protectDirectory(path)
}

func protectDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("expected directory at %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return protectOpened(f, info, 0o700)
}

// OpenPrivateFile opens a regular state file for read/write and applies the
// owner-only mode to the opened inode. A check against lstat prevents changes
// to a symlink target or a file replaced while opening it.
func OpenPrivateFile(path string, create bool) (*os.File, error) {
	info, err := os.Lstat(path)
	if create && errors.Is(err, os.ErrNotExist) {
		f, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if !errors.Is(createErr, os.ErrExist) {
			return f, createErr
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("expected regular state file at %s", path)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	if err := protectOpened(f, info, 0o600); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func protectOpened(f *os.File, expected os.FileInfo, mode os.FileMode) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, expected) {
		return fmt.Errorf("state path changed while opening %s", f.Name())
	}
	return protectFileMode(f, info, mode)
}

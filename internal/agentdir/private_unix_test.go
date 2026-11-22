//go:build unix

package agentdir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProtectDefaultKeepsCustomDirectoryPolicy(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	defaultDir := filepath.Join(home, ".pi", "agent")
	customDir := filepath.Join(home, "shared")
	for _, dir := range []string{defaultDir, customDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := ProtectDefault(dir); err != nil {
			t.Fatal(err)
		}
	}
	checkMode(t, defaultDir, 0o700)
	checkMode(t, customDir, 0o755)
}

func TestPrivatePathsDoNotChangeSymlinkTargets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	relocatedParent := t.TempDir()
	untouched := filepath.Join(relocatedParent, "agent")
	if err := os.Mkdir(untouched, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(untouched, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(relocatedParent, filepath.Join(home, ".pi")); err != nil {
		t.Fatal(err)
	}
	if err := ProtectDefault(filepath.Join(home, ".pi", "agent")); err != nil {
		t.Fatal(err)
	}
	checkMode(t, untouched, 0o755)

	state := filepath.Join(home, "state.json")
	target := filepath.Join(relocatedParent, "target.json")
	if err := os.WriteFile(target, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, state); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenPrivateFile(state, true); err == nil {
		f.Close()
		t.Fatal("accepted a linked state file")
	}
	checkMode(t, target, 0o644)
}

func checkMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode for %s = %o, want %o", path, got, want)
	}
}

//go:build unix

package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProtectDBFilesPreservesExistingRecoveryData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pi-web.sqlite")
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := os.WriteFile(path+suffix, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := protectDBFiles(path); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		info, err := os.Stat(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("database file %q mode = %o", suffix, info.Mode().Perm())
		}
		data, err := os.ReadFile(path + suffix)
		if err != nil || string(data) != "fixture" {
			t.Fatalf("database file %q changed: %v", suffix, err)
		}
	}
}

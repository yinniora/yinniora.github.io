//go:build unix

package relay

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateFileRefusesSymlinksAndGroupRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile")
	if err := writePrivateProfile(path, []byte("example")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, path+".link"); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateFile(path + ".link"); err == nil {
		t.Fatal("accepted a symlink to the private profile")
	}
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateFile(path); !errors.Is(err, errPrivateFile) {
		t.Fatal("accepted a group-readable profile:", err)
	}
}

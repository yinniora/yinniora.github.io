package updater

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestMarkInstallerDownloadRetainsMacQuarantine(t *testing.T) {
	file := filepath.Join(t.TempDir(), "fixture.pkg")
	if err := os.WriteFile(file, []byte("installer fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := markInstallerDownload(file); err != nil {
		t.Fatal(err)
	}
	var value [128]byte
	length, err := unix.Getxattr(file, "com.apple.quarantine", value[:])
	if err != nil || !bytes.HasPrefix(value[:length], []byte("0081;")) || !bytes.HasSuffix(value[:length], []byte(";YuGo Pi;")) {
		t.Fatalf("missing download quarantine: %v", err)
	}
}

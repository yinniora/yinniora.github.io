package updater

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsInstallerStagingPreservesDownloadZone(t *testing.T) {
	directory, err := newInstallerDirectory(t.TempDir(), "update-")
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(directory, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || !owner.Equals(user.User.Sid) {
		t.Fatalf("unexpected owner for installer directory: %v", err)
	}
	control, _, err := descriptor.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("installer directory must have a protected ACL: %v", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		t.Fatalf("installer directory must have a single owner entry: %v", err)
	}
	part := filepath.Join(directory, ".download")
	final := filepath.Join(directory, "setup.exe")
	if err := os.WriteFile(part, []byte("test installer"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := markInstallerDownload(part); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(part, final); err != nil {
		t.Fatal(err)
	}
	zone, err := os.ReadFile(final + ":Zone.Identifier")
	if err != nil || !strings.Contains(string(zone), "ZoneId=3") {
		t.Fatalf("published installer lacks its Internet download marker: %v", err)
	}
}

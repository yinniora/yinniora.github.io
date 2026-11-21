package relay

import (
	"errors"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPrivateFileRefusesBroaderWindowsDACL(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "profile")
	if err := writePrivateProfile(filename, []byte("example")); err != nil {
		t.Fatal(err)
	}
	if contents, err := readPrivateFile(filename); err != nil || string(contents) != "example" {
		t.Fatal("new owner-only file was not readable:", err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(filename, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = readPrivateFile(filename); !errors.Is(err, errPrivateFile) {
		t.Fatal("owner-only access check accepted read access for everyone:", err)
	}
}

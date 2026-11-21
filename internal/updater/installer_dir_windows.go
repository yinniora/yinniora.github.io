package updater

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func newInstallerDirectory(parent, prefix string) (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	owner := user.User.Sid.String()
	// Give full access only to the current user. Child files inherit that ACL.
	descriptor, err := windows.SecurityDescriptorFromString("O:" + owner + "D:P(A;OICI;FA;;;" + owner + ")")
	if err != nil {
		return "", err
	}
	attributes := windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor,
	}
	directory := filepath.Join(parent, prefix+rand.Text())
	path, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return "", err
	}
	if err := windows.CreateDirectory(path, &attributes); err != nil {
		return "", err
	}
	return directory, nil
}

func markInstallerDownload(path string) error {
	// The system installer should retain ordinary Internet-download checks even
	// when the release body came through this application instead of a browser.
	return os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600)
}

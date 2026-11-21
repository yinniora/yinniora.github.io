package app

import (
	"errors"

	"golang.org/x/sys/windows"
)

func openManagedInstaller(path string) error {
	action, _ := windows.UTF16PtrFromString("open")
	filename, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, action, filename, nil, nil, windows.SW_SHOWNORMAL)
}

func replaceManagedProcess(string) error {
	return errors.New("Windows updates use the host installer")
}

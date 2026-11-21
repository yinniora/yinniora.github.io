//go:build !windows

package updater

import "os"

func newInstallerDirectory(parent, prefix string) (string, error) {
	return os.MkdirTemp(parent, prefix)
}

func markInstallerDownload(string) error { return nil }

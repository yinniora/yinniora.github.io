//go:build !windows && !darwin

package updater

func markInstallerDownload(string) error { return nil }

package rpc

import (
	_ "embed"
	"os"
	"path/filepath"
)

//go:embed harness.mjs
var harnessExtension []byte

func InstallHarness(dir string) (string, error) {
	return installWorkerExtension(dir, "yugo-harness.mjs", harnessExtension)
}

func installWorkerExtension(dir, filename string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, ".worker-extension-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, filename)
	if err := os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

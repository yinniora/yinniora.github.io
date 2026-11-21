//go:build !windows

package app

import (
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

func openManagedInstaller(path string) error {
	launcher := "xdg-open"
	if runtime.GOOS == "darwin" {
		launcher = "/usr/bin/open"
	}
	command := exec.Command(launcher, path)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

func replaceManagedProcess(path string) error {
	args := append([]string{path}, os.Args[1:]...)
	return syscall.Exec(path, args, os.Environ())
}

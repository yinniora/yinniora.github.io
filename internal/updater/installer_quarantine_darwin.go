package updater

import (
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

func markInstallerDownload(path string) error {
	// Retain the operating system's ordinary download checks for verified packages.
	value := fmt.Appendf(nil, "0081;%x;YuGo Pi;", time.Now().Unix())
	return unix.Setxattr(path, "com.apple.quarantine", value, 0)
}

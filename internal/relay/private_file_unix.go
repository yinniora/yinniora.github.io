//go:build unix

package relay

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func readPrivateFile(filename string) ([]byte, error) {
	file, err := os.OpenFile(filename, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var stat unix.Stat_t
	if err = unix.Fstat(int(file.Fd()), &stat); err != nil {
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0077 != 0 || stat.Uid != uint32(os.Geteuid()) {
		return nil, errPrivateFile
	}
	return io.ReadAll(file)
}

func createPrivateFile(filename string) (*os.File, error) {
	return os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
}

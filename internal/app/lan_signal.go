package app

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"

	"pi-web/internal/relay"
)

const lanSignalPort = "31418"

type lanSignal struct {
	mu       sync.Mutex
	host     *relay.Host
	control  *relay.Controller
	marker   string
	listener *relay.LANServer
}

func (l *lanSignal) enable() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.listener != nil {
		return nil
	}
	addresses := relay.LANAddresses()
	if len(addresses) == 0 {
		return errors.New("no supported local network address was found")
	}
	var lastErr error
	for _, address := range addresses {
		listener, err := relay.ListenLAN(l.host, net.JoinHostPort(address, lanSignalPort))
		if err != nil {
			lastErr = err
			continue
		}
		if err := l.control.SetLANURL(listener.URL()); err != nil {
			listener.Close()
			return err
		}
		if err := l.remember(); err != nil {
			_ = l.control.SetLANURL("")
			listener.Close()
			return err
		}
		l.listener = listener
		return nil
	}
	return lastErr
}

func (l *lanSignal) remember() error {
	if err := os.MkdirAll(filepath.Dir(l.marker), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(l.marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return file.Close()
}

func (l *lanSignal) restore() error {
	info, err := os.Lstat(l.marker)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("LAN setting must be a regular file")
	}
	return l.enable()
}

func (l *lanSignal) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.listener != nil {
		_ = l.listener.Close()
		l.listener = nil
	}
}

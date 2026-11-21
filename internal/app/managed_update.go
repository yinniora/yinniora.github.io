package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"pi-web/internal/server"
	"pi-web/internal/updater"
	"pi-web/internal/workers"
)

type managedUpdate struct {
	mu             sync.Mutex
	version        string
	checker        *updater.Checker
	busy           func() bool
	executable     string
	previous       string
	packagePath    string
	packageVersion string
}

func (m *managedUpdate) install(ctx context.Context, target string) (server.ManagedUpdateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := server.ManagedUpdateResult{Version: target}
	release := m.checker.Info().YuGoRelease
	if release == nil || !release.HasUpdate || release.Latest != target {
		return result, errors.New("check for a published YuGo update first")
	}
	if m.previous != "" {
		result.NeedsRestart, result.Mode = true, "backend"
		return result, nil
	}
	executable, executableErr := os.Executable()
	if executableErr == nil && updater.BackendUpdateSupported(executable) && canRestartManagedBackend(ctx) {
		backup, err := updater.InstallBackend(ctx, executable, m.version, release.Latest)
		if err == nil {
			m.executable, m.previous = executable, backup
			result.NeedsRestart, result.Mode = true, "backend"
			return result, nil
		}
		if !errors.Is(err, updater.ErrFullInstallerRequired) {
			return result, err
		}
	}
	if m.packageVersion != target {
		download, err := updater.DownloadInstaller(ctx, *release, updater.HostInstaller)
		if err != nil {
			return result, err
		}
		m.packagePath, m.packageVersion = download.Path, target
	}
	if m.busy() {
		return result, workers.ErrRestartBusy
	}
	result.Mode = "installer"
	return result, openManagedInstaller(m.packagePath)
}

func canRestartManagedBackend(ctx context.Context) bool {
	if runtime.GOOS != "darwin" {
		return runtime.GOOS == "linux"
	}
	check, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(check, "/bin/launchctl", "print", managedLaunchJob()).Output()
	if err != nil {
		return false
	}
	return strings.Contains("\n"+strings.Join(strings.Fields(string(output)), " ")+" ", " pid = "+strconv.Itoa(os.Getpid())+" ")
}

func managedLaunchJob() string { return "gui/" + strconv.Itoa(os.Getuid()) + "/com.pi-web" }

func (m *managedUpdate) restart() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.previous == "" {
		return server.ErrManagedUpdateRestage
	}
	if runtime.GOOS == "linux" {
		// Exec preserves the user supervisor's PID. Delay until the browser
		// receives the acknowledgement and keep this process alive on failure.
		time.AfterFunc(time.Second, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if err := replaceManagedProcess(m.executable); err != nil {
				_ = m.rollback(err)
			}
		})
		return nil
	}
	if runtime.GOOS == "darwin" {
		if !canRestartManagedBackend(context.Background()) {
			return m.rollback(errors.New("could not locate the running YuGo Pi launch agent"))
		}
		command := exec.Command("/bin/sh", "-c", `sleep 1; exec /bin/launchctl kickstart -k "$1"`, "yugopi-restart", managedLaunchJob())
		detachSession(command)
		if err := command.Start(); err != nil {
			return m.rollback(err)
		}
		go func() {
			if err := command.Wait(); err != nil {
				m.mu.Lock()
				defer m.mu.Unlock()
				_ = m.rollback(err)
			}
		}()
		return nil
	}
	return m.rollback(errors.New("this host requires the full installer"))
}

func (m *managedUpdate) rollback(err error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rollback := updater.RollbackBackend(ctx, m.executable, m.previous, m.version)
	if rollback == nil {
		m.executable, m.previous = "", ""
		return errors.Join(err, server.ErrManagedUpdateRestage)
	}
	return errors.Join(err, rollback)
}

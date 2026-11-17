package app

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"pi-web/internal/agentdir"
	"pi-web/internal/auth"
	"pi-web/internal/frontend"
	"pi-web/internal/relay"
	"pi-web/internal/rpc"
	"pi-web/internal/server"
	"pi-web/internal/sessions"
	"pi-web/internal/ui"
	"pi-web/internal/updater"
	"pi-web/internal/workers"
	"pi-web/web"
)

const defaultPort = "31415"
const tokenEnvVar = "PI_WEB_TOKEN"
const developmentEnvVar = "PI_WEB_DEV"

// Main runs the pi-web application. version is supplied by cmd/pi-web so
// release builds can set it with -ldflags "-X main.version=...".
func Main(version string) {
	port := flag.String("p", defaultPort, "port to listen on")
	hostOverride := flag.String("host", "", "host/IP to bind; defaults to 127.0.0.1")
	extraHost := flag.String("extra-host", "", "optional additional private listener, retried when unavailable")
	open := flag.Bool("o", false, "auto-open browser")
	insecure := flag.Bool("insecure", false, "allow non-loopback bind without "+tokenEnvVar+" (DANGEROUS)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	developmentMode := os.Getenv(developmentEnvVar) == "1"

	agentDir := agentdir.Path()
	if err := seedSoundsDir(agentDir); err != nil {
		fmt.Fprintf(os.Stderr, "failed to seed sounds directory: %v\n", err)
	}
	sessionsDir := filepath.Join(agentDir, "sessions")
	if _, err := os.Stat(sessionsDir); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "sessions directory not found: %s\n", sessionsDir)
		os.Exit(1)
	}

	bindHost := chooseBindHost(*hostOverride)
	token := os.Getenv(tokenEnvVar)
	tokenRequired := token == "" && (!isLoopbackHost(bindHost) || (*extraHost != "" && !isLoopbackHost(*extraHost))) && !*insecure
	if tokenRequired {
		fmt.Fprintf(os.Stderr,
			"refusing to bind %s without %s set: anyone reachable on this address could view sessions and drive pi.\n"+
				"  set %s=$(openssl rand -hex 16) to require a token, or pass --insecure to override.\n",
			bindHost, tokenEnvVar, tokenEnvVar)
		os.Exit(1)
	}
	authMiddleware := auth.New(token)
	authMiddleware.AllowHost(bindHost)
	if *insecure {
		authMiddleware.AllowAnyHost()
	}

	versionChecker := updater.NewTracking(version)
	deviceEnabled := os.Getenv("PI_WEB_DEVICE_AUTH") == "1"
	var remoteHost *relay.Host
	if deviceEnabled {
		var err error
		remoteHost, err = relay.NewHost(filepath.Join(agentDir, "remote", "identity.pem"))
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot initialize Mac remote identity:", err)
			os.Exit(1)
		}
	}
	var remoteControl *relay.Controller
	if remoteHost != nil {
		var err error
		remoteControl, err = relay.NewController(remoteHost, filepath.Join(agentDir, "remote", "connection.json"), relay.ConnectionConfig{
			ClientURL: os.Getenv("PI_WEB_REMOTE_CLIENT_URL"), SignalURL: os.Getenv("PI_WEB_REMOTE_SIGNAL_URL"), ICEURL: os.Getenv("PI_WEB_REMOTE_ICE_URL"), DirectURL: os.Getenv("PI_WEB_REMOTE_DIRECT_URL"),
			HostToken: os.Getenv("PI_WEB_RELAY_HOST_TOKEN"), TURNHost: os.Getenv("PI_WEB_REMOTE_TURN_IP"), TURNSecret: os.Getenv("PI_WEB_REMOTE_TURN_SECRET"), ClientSecret: os.Getenv("PI_WEB_RELAY_CLIENT_SECRET"),
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot initialize remote configuration")
			os.Exit(1)
		}
	}
	bootstrapRemote := func() map[string]any {
		if remoteControl != nil {
			return remoteControl.Bootstrap()
		}
		return nil
	}
	approvePair := func(ctx context.Context, name string) error {
		helper := os.Getenv("PI_WEB_PAIR_APPROVER")
		if !filepath.IsAbs(helper) {
			return fmt.Errorf("Mac approval helper is not configured")
		}
		args := []string{name}
		if strings.HasPrefix(name, "remote-server:") {
			args = []string{"--remote-server", strings.TrimPrefix(name, "remote-server:")}
		}
		output, err := exec.CommandContext(ctx, helper, args...).Output()
		if err != nil || strings.TrimSpace(string(output)) != "approved" {
			return fmt.Errorf("Mac system authentication was not completed")
		}
		return nil
	}

	var trashProjectFiles func(context.Context, string) (string, error)
	if filepath.IsAbs(os.Getenv("PI_WEB_PROJECT_TRASH_HELPER")) {
		trashProjectFiles = func(ctx context.Context, path string) (string, error) {
			helper := os.Getenv("PI_WEB_PROJECT_TRASH_HELPER")
			if !filepath.IsAbs(helper) {
				return "", fmt.Errorf("Mac Trash helper is not configured")
			}
			output, err := exec.CommandContext(ctx, helper, path).Output()
			if err != nil {
				return "", err
			}
			var result struct {
				Path string `json:"path"`
			}
			if err = json.Unmarshal(output, &result); err != nil {
				return "", err
			}
			return result.Path, nil
		}
	}
	var srv *server.Server
	manager := workers.NewManager(func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		return rpc.NewPiWorkerWithStream(sessionPath, func(preview rpc.StreamPreview) {
			if srv != nil {
				srv.BroadcastChatPreview(sessionID, preview)
			}
		})
	})
	var srvErr error
	srv, srvErr = server.New(server.Deps{
		TrashProjectFiles:   trashProjectFiles,
		AgentDir:            agentDir,
		SessionsDir:         sessionsDir,
		Auth:                authMiddleware,
		EnforceDeviceAuth:   deviceEnabled,
		PairApprover:        approvePair,
		RemoteBootstrap:     bootstrapRemote,
		RemoteControl:       remoteControl,
		ChatSender:          manager,
		Cache:               sessions.NewCache(),
		RenderExportSession: ui.RenderExportSessionPage,
		RenderAppShell:      ui.RenderAppShell,
		Models: func(ctx context.Context) (json.RawMessage, error) {
			return defaultModelsCache.get(ctx)
		},
		Updater: versionChecker,
		RunInstall: func(ctx context.Context) error {
			return fmt.Errorf("this fork is updated from its maintained source repository")
		},
		RunRestart:            runRestart,
		DisableBackgroundJobs: developmentMode,
	})
	if srvErr != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize server: %v\n", srvErr)
		os.Exit(1)
	}

	ui.SetThemeProvider(srv.ThemeSetting)
	ui.SetFontProvider(srv.FontStyles)

	mux := http.NewServeMux()
	srv.Register(mux)
	if remoteHost != nil {
		remoteHost.Authorize = srv.AuthorizeRemoteDevice
		remoteHost.WatchDevice = srv.WatchRemoteDevice
		remoteHost.Handler = func(w http.ResponseWriter, r *http.Request, id string) {
			mux.ServeHTTP(w, auth.WithApprovedDevice(r, id))
		}
		if u, err := url.Parse(remoteControl.Bootstrap()["clientUrl"].(string)); err == nil && u.Host != "" {
			remoteHost.Origins = []string{u.Host}
		}
		remoteHost.DeviceIDs = srv.ApprovedRemoteDeviceIDs
		mux.HandleFunc("/remote-signal", remoteHost.ServeSignal)
	}
	ui.RegisterPWAHandlers(mux)
	dfs := web.DistFS()
	if scripts, err := frontend.LoadScripts(dfs, frontend.AppEntry); err == nil {
		for _, script := range scripts {
			if script.Entry == frontend.AppEntry {
				ui.SetAppScriptPath(script.Path)
				ui.SetAppStylePaths(script.CSS)
			}
			mux.HandleFunc(script.Path, frontend.ServeJS(script.JS, true))
		}
		// Serve all other hashed assets (lazy chunks, runtime) from the embed FS.
		mux.HandleFunc("/static/assets/", frontend.ServeStaticAssets(dfs))
	} else {
		fmt.Fprintf(os.Stderr, "WARNING: failed to load Vite frontend scripts: %v (frontend JS will be unavailable)\n", err)
	}

	addr := net.JoinHostPort(bindHost, *port)
	localURL := fmt.Sprintf("http://%s", net.JoinHostPort(bindHost, *port))
	var tailscaleURL string
	var tailscaleServe bool
	if *hostOverride == "" && !authMiddleware.Enabled() {
		// Tailscale Serve proxies the tailnet to this loopback server, and its
		// hostname would be allowlisted for tokenless access below. Without a
		// token that turns a loopback-only deployment into unauthenticated
		// tailnet-wide access to the agent, so stay loopback-only instead.
		fmt.Fprintf(os.Stderr,
			"Tailscale Serve not configured: set %s to publish an HTTPS tailnet endpoint.\n"+
				"  Without a token, pi-web stays loopback-only so tailnet peers cannot reach the agent unauthenticated.\n",
			tokenEnvVar)
	} else if *hostOverride == "" {
		tsCtx, tsCancel := context.WithTimeout(context.Background(), tailscaleConfigureTimeout)
		tsURL, tsOk, tsErr := configureTailscaleServe(tsCtx, *port)
		tsCancel()
		if tsErr == nil && tsOk {
			tailscaleURL = tsURL
			tailscaleServe = true
			authMiddleware.AllowHost(tsURL)
		} else if tsErr != nil {
			if tsCtx.Err() == context.DeadlineExceeded {
				fmt.Fprintf(os.Stderr, "Tailscale Serve timed out after %s; continuing without it\n", tailscaleConfigureTimeout)
			} else {
				fmt.Fprintf(os.Stderr, "Tailscale Serve unavailable: %v\n", tsErr)
			}
		}
	}
	fmt.Printf("Pi Sessions Viewer -> %s\n", localURL)
	if tailscaleURL != "" {
		fmt.Printf("Tailscale HTTPS -> %s\n", tailscaleURL)
	}
	fmt.Printf("Serving from: %s\n", sessionsDir)
	if developmentMode {
		fmt.Println("Development mode: autonomous jobs disabled")
	}
	if authMiddleware.Enabled() {
		fmt.Println("Auth: enabled (set PI_WEB_TOKEN to require token)")
	} else {
		fmt.Printf("Auth: disabled — set %s to require a token for access.\n", tokenEnvVar)
	}

	stateFilePath, stateFile, err := writeStateFile(agentDir, developmentMode, bindHost, *port, tailscaleServe, tailscaleURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
	// Shared with the signal path below, which exits via os.Exit and so does not
	// run deferred functions.
	releaseStateFile := func() {
		// Unlink while this process still owns the lock so an exiting instance
		// cannot remove a successor's newly written state file.
		_ = os.Remove(stateFilePath)
		_ = stateFile.Close()
	}
	defer releaseStateFile()

	if *open {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(localURL)
		}()
	}

	warmModelsCache()

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.WrapDevices(mux, false),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout intentionally 0 — SSE streams are long-lived.
	}

	// signal.NotifyContext would hide which signal arrived, and returning
	// normally afterwards made a SIGTERM kill indistinguishable from a clean
	// quit in launchd's "last exit code = 0" (#119). Name the signal and exit
	// 128+signum so a supervisor can tell the two apart.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	ctx, cancelCtx := context.WithCancel(context.Background())
	defer cancelCtx()
	if remoteHost != nil {
		// This listener exposes signaling only. Even a local reverse proxy cannot
		// turn it into a loopback administrator for the workspace HTTP API.
		if directAddress := os.Getenv("PI_WEB_DIRECT_SIGNAL_ADDR"); directAddress != "" {
			directServer := &http.Server{Addr: directAddress, Handler: http.HandlerFunc(remoteHost.ServeSignal), ReadHeaderTimeout: 10 * time.Second}
			go func() {
				if err := directServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					fmt.Fprintln(os.Stderr, "direct signaling listener:", err)
				}
			}()
			defer directServer.Close()
		}
		remoteControl.Start(ctx)
		defer remoteHost.Close()
	}

	go versionChecker.Start(ctx)
	if *extraHost != "" {
		authMiddleware.AllowHost(*extraHost)
		go func() {
			for ctx.Err() == nil {
				listener, err := net.Listen("tcp", net.JoinHostPort(*extraHost, *port))
				if err == nil {
					fmt.Printf("Private direct listener -> http://%s\n", listener.Addr())
					err = httpServer.Serve(listener)
					if err == http.ErrServerClosed {
						return
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
				}
			}
		}()
	}

	shutdownCode := make(chan int, 1)
	go func() {
		sig := <-signals
		fmt.Fprintf(os.Stderr, "shutting down: received %s\n", sig)
		cancelCtx()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		srv.Shutdown()
		_ = manager.Close()
		releaseStateFile()
		code := 0
		if num, ok := sig.(syscall.Signal); ok {
			code = 128 + int(num)
		}
		shutdownCode <- code
	}()

	serveErr := httpServer.ListenAndServe()
	if serveErr != nil && serveErr != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "server error: %v\n", serveErr)
		os.Exit(1)
	}
	// ErrServerClosed only reaches here via the signal handler above, which is
	// the sole Shutdown caller; wait so cleanup is not cut short by exiting.
	os.Exit(<-shutdownCode)
}

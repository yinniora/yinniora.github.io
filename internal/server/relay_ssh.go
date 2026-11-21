package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	relayInstallerAsset = "yugo-pi-relay-install.py"
	relayInstallerRepo  = "yinniora/yugo-pi"
	relayInstallerLimit = 256 * 1024
)

var (
	relaySSHUserPattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,31}$`)
	relaySSHHostLabel   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	relaySSHReleaseTag  = regexp.MustCompile(`^yugo-v[0-9]+\.[0-9]+\.[0-9]+-yugo\.[0-9]+$`)
)

type relaySSHSetup struct {
	SSHHost   string `json:"sshHost"`
	SSHUser   string `json:"sshUser"`
	SSHPort   int    `json:"sshPort"`
	ServerURL string `json:"serverUrl"`
}

func normalizeRelaySSHSetup(input relaySSHSetup) (relaySSHSetup, error) {
	input.SSHHost = strings.TrimSpace(input.SSHHost)
	input.SSHUser = strings.TrimSpace(input.SSHUser)
	input.ServerURL = strings.TrimSpace(input.ServerURL)
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if !relaySSHUserPattern.MatchString(input.SSHUser) || input.SSHPort < 1 || input.SSHPort > 65535 {
		return relaySSHSetup{}, errors.New("enter a valid SSH account and port")
	}
	if input.ServerURL == "" && input.SSHHost != "" {
		host := cleanRelaySSHHost(input.SSHHost)
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		input.ServerURL = "https://" + host
	}
	if !strings.Contains(input.ServerURL, "://") {
		if address, err := netip.ParseAddr(strings.Trim(input.ServerURL, "[]")); err == nil && address.Is6() && address.Zone() == "" {
			input.ServerURL = "[" + address.String() + "]"
		}
		input.ServerURL = "https://" + input.ServerURL
	}
	u, err := url.Parse(input.ServerURL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") || (u.Port() != "" && u.Port() != "443") {
		return relaySSHSetup{}, errors.New("enter the relay's public HTTPS address")
	}
	host := cleanRelaySSHHost(u.Hostname())
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".localhost") ||
		(!strings.Contains(host, ".") && !strings.Contains(host, ":")) {
		return relaySSHSetup{}, errors.New("enter the relay's public HTTPS address")
	}
	if addr, err := netip.ParseAddr(host); err == nil && (!addr.IsGlobalUnicast() || addr.IsPrivate()) {
		return relaySSHSetup{}, errors.New("enter the relay's public HTTPS address")
	}
	if input.SSHHost == "" {
		input.SSHHost = host
	}
	input.SSHHost = cleanRelaySSHHost(input.SSHHost)
	if input.SSHHost == "" {
		return relaySSHSetup{}, errors.New("enter an SSH hostname or IP address")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	input.ServerURL = "https://" + host
	return input, nil
}

func cleanRelaySSHHost(input string) string {
	// A valid hostname/IP has no shell metacharacters, user, port or SSH options.
	if strings.HasPrefix(input, "[") && strings.HasSuffix(input, "]") {
		addr, err := netip.ParseAddr(input[1 : len(input)-1])
		if err != nil || !addr.Is6() || addr.Zone() != "" {
			return ""
		}
		return addr.String()
	}
	if addr, err := netip.ParseAddr(input); err == nil {
		if addr.Zone() != "" {
			return ""
		}
		return addr.String()
	}
	host := strings.ToLower(input)
	if len(host) == 0 || len(host) > 253 {
		return ""
	}
	for _, label := range strings.Split(host, ".") {
		if !relaySSHHostLabel.MatchString(label) {
			return ""
		}
	}
	return host
}

func systemRelaySSH() string {
	ssh := "/usr/bin/ssh"
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if !filepath.IsAbs(root) {
			return ""
		}
		ssh = filepath.Join(root, "System32", "OpenSSH", "ssh.exe")
	}
	if stat, err := os.Stat(ssh); err != nil || !stat.Mode().IsRegular() {
		return ""
	}
	return ssh
}

func relaySSHArgs(input relaySSHSetup, tag string) []string {
	// Both interpolated values have already been normalized to their fixed
	// command-safe alphabets. Quotes also avoid IPv6 bracket globbing.
	remote := "exec sudo -n -- python3 -"
	if input.SSHUser == "root" {
		remote = "exec python3 -"
	}
	remote += " --server '" + input.ServerURL + "' --version '" + tag + "'"
	return []string{
		"-F", "none", "-T",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "VerifyHostKeyDNS=no",
		"-o", "CheckHostIP=no",
		"-o", "UpdateHostKeys=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
		"-o", "ConnectTimeout=12",
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=3",
		"-p", strconv.Itoa(input.SSHPort), "-l", input.SSHUser,
		"--", input.SSHHost, remote,
	}
}

func provisionRelaySSH(ctx context.Context, input relaySSHSetup, version string) (relayActivation, error) {
	input, err := normalizeRelaySSHSetup(input)
	if err != nil {
		return relayActivation{}, err
	}
	tag := "yugo-v" + strings.TrimPrefix(version, "yugo-v")
	if !relaySSHReleaseTag.MatchString(tag) {
		return relayActivation{}, errors.New("SSH setup requires an installed YuGo release")
	}
	ssh := systemRelaySSH()
	if ssh == "" {
		return relayActivation{}, errors.New("install the system OpenSSH client for SSH setup")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 5 || r.URL.Scheme != "https" || r.URL.User != nil || (r.URL.Port() != "" && r.URL.Port() != "443") {
				return errors.New("unexpected relay installer download redirect")
			}
			switch r.URL.Hostname() {
			case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
				return nil
			default:
				return errors.New("unexpected relay installer download host")
			}
		},
	}
	script, err := downloadRelayInstaller(ctx, client, tag)
	if err != nil {
		return relayActivation{}, err
	}
	capture := &relayActivationOutput{origin: input.ServerURL}
	command := exec.CommandContext(ctx, ssh, relaySSHArgs(input, tag)...)
	command.Stdin = bytes.NewReader(script)
	command.Stdout = capture
	command.Stderr = io.Discard
	command.WaitDelay = 2 * time.Second
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return relayActivation{}, errors.New("SSH setup timed out or was cancelled. Retry the same VPS or import its setup code")
		}
		return relayActivation{}, errors.New("SSH setup failed. Check the trusted host key, your SSH key and noninteractive sudo, or import a setup code")
	}
	capture.finishLine()
	if capture.matches != 1 || capture.activation.ServerURL != input.ServerURL {
		return relayActivation{}, errors.New("the VPS installer did not return one valid setup code for this relay")
	}
	return capture.activation, nil
}

func downloadRelayInstaller(ctx context.Context, client *http.Client, tag string) ([]byte, error) {
	if !relaySSHReleaseTag.MatchString(tag) {
		return nil, errors.New("invalid relay installer release")
	}
	assetURL := "https://github.com/" + relayInstallerRepo + "/releases/download/" + tag + "/" + relayInstallerAsset
	metadataURL := "https://api.github.com/repos/" + relayInstallerRepo + "/releases/tags/" + tag
	metadata, err := readRelayRelease(ctx, client, metadataURL, 1024*1024)
	if err != nil {
		return nil, errors.New("cannot verify this YuGo release's relay installer")
	}
	var release struct {
		Tag    string `json:"tag_name"`
		Draft  bool   `json:"draft"`
		Assets []struct {
			Name   string `json:"name"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if json.Unmarshal(metadata, &release) != nil || release.Tag != tag || release.Draft {
		return nil, errors.New("cannot verify this YuGo release's relay installer")
	}
	var digest []byte
	for _, a := range release.Assets {
		if a.Name != relayInstallerAsset {
			continue
		}
		encoded, found := strings.CutPrefix(a.Digest, "sha256:")
		decoded, err := hex.DecodeString(encoded)
		if digest != nil || !found || err != nil || len(decoded) != sha256.Size {
			return nil, errors.New("relay installer release digest is invalid")
		}
		digest = decoded
	}
	if digest == nil {
		return nil, errors.New("this YuGo release has no verified relay installer")
	}
	script, err := readRelayRelease(ctx, client, assetURL, relayInstallerLimit)
	if err != nil {
		return nil, errors.New("cannot download the verified relay installer")
	}
	actual := sha256.Sum256(script)
	if subtle.ConstantTimeCompare(digest, actual[:]) != 1 {
		return nil, errors.New("relay installer SHA-256 verification failed")
	}
	return script, nil
}

func readRelayRelease(ctx context.Context, client *http.Client, address string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("relay release asset is unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit || len(body) == 0 {
		return nil, errors.New("relay release response is incomplete or too large")
	}
	return body, nil
}

// The installer writes human-readable diagnostics and a protocol result. Retain
// at most a single possible result line at a time. Never keep or relay logs.
type relayActivationOutput struct {
	origin     string
	activation relayActivation
	matches    int
	pending    [len(relayActivationPrefix) + 1024 + 1]byte
	used       int
	truncated  bool
}

func (o *relayActivationOutput) Write(data []byte) (int, error) {
	written := len(data)
	for len(data) > 0 {
		n := bytes.IndexByte(data, '\n')
		part := data
		if n >= 0 {
			part = data[:n]
		}
		if !o.truncated && o.used < len(relayActivationPrefix) {
			prefixBytes := min(len(part), len(relayActivationPrefix)-o.used)
			o.truncated = string(part[:prefixBytes]) != relayActivationPrefix[o.used:o.used+prefixBytes]
		}
		if len(part)+o.used <= len(o.pending) && !o.truncated {
			o.used += copy(o.pending[o.used:], part)
		} else {
			o.truncated = true
		}
		if n < 0 {
			break
		}
		o.finishLine()
		data = data[n+1:]
	}
	return written, nil
}

func (o *relayActivationOutput) finishLine() {
	if !o.truncated && bytes.HasPrefix(o.pending[:o.used], []byte(relayActivationPrefix)) {
		o.matches++
		if o.matches == 1 {
			activation, err := parseRelayActivation(string(o.pending[:o.used]))
			if err == nil && activation.ServerURL == o.origin {
				o.activation = activation
			}
		}
	}
	clear(o.pending[:o.used])
	o.used = 0
	o.truncated = false
}

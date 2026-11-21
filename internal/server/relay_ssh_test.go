package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeRelaySSHSetupAndCommand(t *testing.T) {
	for _, tt := range []struct {
		input, want relaySSHSetup
		command     string
	}{
		{
			input:   relaySSHSetup{SSHUser: "ubuntu", ServerURL: "HTTPS://VPS.Example.com:443/"},
			want:    relaySSHSetup{SSHUser: "ubuntu", SSHHost: "vps.example.com", SSHPort: 22, ServerURL: "https://vps.example.com"},
			command: "exec sudo -n -- python3 - --server 'https://vps.example.com' --version 'yugo-v0.1.0-yugo.61'",
		},
		{
			input:   relaySSHSetup{SSHUser: "root", SSHHost: "[2606:4700:4700::1001]", SSHPort: 2222},
			want:    relaySSHSetup{SSHUser: "root", SSHHost: "2606:4700:4700::1001", SSHPort: 2222, ServerURL: "https://[2606:4700:4700::1001]"},
			command: "exec python3 - --server 'https://[2606:4700:4700::1001]' --version 'yugo-v0.1.0-yugo.61'",
		},
		{
			input:   relaySSHSetup{SSHUser: "pi", SSHHost: "192.168.0.3", SSHPort: 22, ServerURL: "relay.example.net"},
			want:    relaySSHSetup{SSHUser: "pi", SSHHost: "192.168.0.3", SSHPort: 22, ServerURL: "https://relay.example.net"},
			command: "exec sudo -n -- python3 - --server 'https://relay.example.net' --version 'yugo-v0.1.0-yugo.61'",
		},
	} {
		got, err := normalizeRelaySSHSetup(tt.input)
		if err != nil || !reflect.DeepEqual(got, tt.want) {
			t.Fatalf("normalize %v = %v, %v, want %v", tt.input, got, err, tt.want)
		}
		args := relaySSHArgs(got, "yugo-v0.1.0-yugo.61")
		if !reflect.DeepEqual(args[len(args)-3:], []string{"--", got.SSHHost, tt.command}) ||
			!reflect.DeepEqual(args[:3], []string{"-F", "none", "-T"}) {
			t.Fatalf("unexpected command: %q", args)
		}
		for _, required := range []string{"BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes", "UpdateHostKeys=no"} {
			if !strings.Contains(strings.Join(args, " "), "-o "+required) {
				t.Fatalf("missing %s", required)
			}
		}
	}
}

func TestRelaySSHRejectsUntrustedDestinationSyntax(t *testing.T) {
	for _, input := range []relaySSHSetup{
		{SSHUser: "-oProxyCommand=evil", ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHHost: "-oProxyCommand=evil", ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHHost: "root@vps.example.com", ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHHost: "vps.example.com;echo bad", ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHHost: "vps.example.com\necho bad", ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHPort: 65536, ServerURL: "vps.example.com"},
		{SSHUser: "root", SSHHost: "[fe80::1%eth0]", ServerURL: "vps.example.com"},
		{SSHUser: "root", ServerURL: "http://vps.example.com/"},
		{SSHUser: "root", ServerURL: "https://user@vps.example.com/"},
		{SSHUser: "root", ServerURL: "https://vps.example.com:8443/"},
		{SSHUser: "root", ServerURL: "https://vps.example.com/x"},
		{SSHUser: "root", ServerURL: "https://vps.example.com/?settings="},
		{SSHUser: "root", ServerURL: "https://vps.example.com/#pair=private"},
		{SSHUser: "root", ServerURL: "https://127.0.0.1/"},
		{SSHUser: "root", ServerURL: "https://192.168.1.1/"},
	} {
		if _, err := normalizeRelaySSHSetup(input); err == nil {
			t.Fatalf("accepted malformed destination: %+v", input)
		}
	}
}

func TestRelaySSHOutputCapturesOnlyOneMatchingActivation(t *testing.T) {
	const origin = "https://relay.example.com"
	code := func(serverURL string) string {
		t.Helper()
		data, err := json.Marshal(relayActivation{ServerURL: serverURL, Token: strings.Repeat("a", 64)})
		if err != nil {
			t.Fatal(err)
		}
		return relayActivationPrefix + base64.RawURLEncoding.EncodeToString(data)
	}
	for _, tt := range []struct {
		out     string
		matches int
		active  bool
	}{
		{"working\n" + strings.Repeat("x", 1<<20) + "\n" + code(origin) + "\r\n", 1, true},
		{"working\n" + code(origin), 1, true},
		{code(origin) + "\n" + code(origin) + "\n", 2, true},
		{"not a result: " + code(origin) + "\n", 0, false},
		{code("https://wrong.example.com") + "\n", 1, false},
		{relayActivationPrefix + strings.Repeat("a", 1<<20) + "\n", 0, false},
	} {
		capture := &relayActivationOutput{origin: origin}
		for i := 0; i < len(tt.out); i += 9 {
			n := min(i+9, len(tt.out))
			if written, err := capture.Write([]byte(tt.out[i:n])); err != nil || written != n-i {
				t.Fatal("short write")
			}
		}
		capture.finishLine()
		if capture.matches != tt.matches || (capture.activation.ServerURL == origin) != tt.active || capture.used != 0 {
			t.Fatalf("unexpected capture with %d bytes and %d matches", len(tt.out), capture.matches)
		}
	}
}

func TestRelaySSHInstallerIsMatchedToReleaseAndVerified(t *testing.T) {
	const tag = "yugo-v0.1.0-yugo.61"
	script := []byte("# verified installer\n")
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(script))
	for _, tt := range []struct {
		name, manifestTag, digest string
		draft                     bool
		content                   []byte
		calls                     int
		want                      bool
	}{
		{"match", tag, digest, false, script, 2, true},
		{"wrong release", "yugo-v0.1.0-yugo.60", digest, false, script, 1, false},
		{"draft", tag, digest, true, script, 1, false},
		{"missing verified digest", tag, "", false, script, 1, false},
		{"mismatch", tag, digest, false, []byte("tampered\n"), 2, false},
		{"too large", tag, digest, false, bytes.Repeat([]byte{'x'}, relayInstallerLimit+1), 2, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var calls int
			client := &http.Client{Transport: relayRoundTrip(func(req *http.Request) (*http.Response, error) {
				calls++
				var body []byte
				switch req.URL.String() {
				case "https://api.github.com/repos/yinniora/yugo-pi/releases/tags/" + tag:
					body = fmt.Appendf(nil, `{"tag_name":%q,"draft":%t,"assets":[{"name":%q,"digest":%q,"browser_download_url":"https://wrong.example.com"}]}`,
						tt.manifestTag, tt.draft, relayInstallerAsset, tt.digest)
				case "https://github.com/yinniora/yugo-pi/releases/download/" + tag + "/" + relayInstallerAsset:
					body = tt.content
				default:
					t.Fatalf("unexpected release URL: %s", req.URL)
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body))}, nil
			})}
			output, err := downloadRelayInstaller(context.Background(), client, tag)
			if (err == nil) != tt.want || calls != tt.calls || (tt.want && !bytes.Equal(output, script)) {
				t.Fatalf("downloaded %d bytes after %d requests: %v", len(output), calls, err)
			}
		})
	}
}

type relayRoundTrip func(*http.Request) (*http.Response, error)

func (f relayRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const installerTestVersion = "0.1.0-yugo.61"

func TestInstallerAssetNameMatchesNativePackages(t *testing.T) {
	for _, tt := range []struct {
		role         InstallerRole
		system, arch string
		suffix       string
	}{
		{HostInstaller, "darwin", "arm64", "host-0.1.0-yugo.61-macos-arm64.pkg"},
		{HostInstaller, "darwin", "amd64", "host-0.1.0-yugo.61-macos-x64.pkg"},
		{HostInstaller, "windows", "amd64", "host-0.1.0-yugo.61-windows-x64-setup.exe"},
		{HostInstaller, "linux", "amd64", "host-0.1.0-yugo.61-linux-amd64.deb"},
		{HostInstaller, "linux", "arm64", "host-0.1.0-yugo.61-linux-arm64.deb"},
		{ClientInstaller, "darwin", "amd64", "client-0.1.0-yugo.61-mac-x64.dmg"},
		{ClientInstaller, "windows", "arm64", "client-0.1.0-yugo.61-windows-arm64-setup.exe"},
		{ClientInstaller, "linux", "amd64", "client-0.1.0-yugo.61-linux-amd64.deb"},
		{AppImageClientInstaller, "linux", "amd64", "client-0.1.0-yugo.61-linux-x86_64.AppImage"},
		{AppImageClientInstaller, "linux", "arm64", "client-0.1.0-yugo.61-linux-arm64.AppImage"},
	} {
		if got := InstallerAssetName(installerTestVersion, tt.role, tt.system, tt.arch); got != "yugo-pi-"+tt.suffix {
			t.Errorf("%s/%s %s: %s, want %s", tt.system, tt.arch, tt.role, got, tt.suffix)
		}
	}
	if InstallerAssetName("../../latest", HostInstaller, "darwin", "amd64") != "" ||
		InstallerAssetName(installerTestVersion, HostInstaller, "windows", "386") != "" ||
		InstallerAssetName(installerTestVersion, HostInstaller, "freebsd", "amd64") != "" ||
		InstallerAssetName(installerTestVersion, AppImageClientInstaller, "darwin", "amd64") != "" {
		t.Fatal("installer mapping accepted unsupported destination")
	}
}

func TestDownloadInstallerOnlyExposesVerifiedCompletePackage(t *testing.T) {
	const asset = "yugo-pi-host-0.1.0-yugo.61-macos-arm64.pkg"
	const tag = "yugo-v" + installerTestVersion
	original := []byte("verified test package")
	sha := fmt.Sprintf("sha256:%x", sha256.Sum256(original))
	release := YuGoRelease{Latest: installerTestVersion, HasUpdate: true,
		URL: "https://example.net/malformed", DownloadURL: "https://example.net/substitution.exe"}
	for _, tt := range []struct {
		name, releaseTag, assetName, digest, state string
		filesize, length, calls                    int64
		body                                       []byte
		want                                       bool
	}{
		{"verified", tag, asset, sha, "uploaded", int64(len(original)), int64(len(original)), 2, original, true},
		{"chunked", tag, asset, sha, "uploaded", int64(len(original)), -1, 2, original, true},
		{"wrong tag", "yugo-v0.1.0-yugo.60", asset, sha, "uploaded", int64(len(original)), -1, 1, original, false},
		{"wrong platform", tag, "unrelated.exe", sha, "uploaded", int64(len(original)), -1, 1, original, false},
		{"malformed digest", tag, asset, "md5:123", "uploaded", int64(len(original)), -1, 1, original, false},
		{"not uploaded", tag, asset, sha, "new", int64(len(original)), -1, 1, original, false},
		{"excess size", tag, asset, sha, "uploaded", maxInstallerSize + 1, -1, 1, original, false},
		{"unexpected content length", tag, asset, sha, "uploaded", int64(len(original)), 1, 2, original, false},
		{"truncated body", tag, asset, sha, "uploaded", int64(len(original)), -1, 2, original[:len(original)-1], false},
		{"tampered body", tag, asset, sha, "uploaded", int64(len(original)), -1, 2, bytes.Repeat([]byte{'X'}, len(original)), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			folder := t.TempDir()
			var calls int64
			client := &http.Client{Transport: installerRoundTrip(func(req *http.Request) (*http.Response, error) {
				calls++
				if req.Header.Get("Authorization") != "" {
					t.Fatal("the public release fetch sent a credential")
				}
				var response []byte
				var size int64
				switch req.URL.String() {
				case "https://api.github.com/repos/yinniora/yugo-pi/releases/tags/" + tag:
					response = fmt.Appendf(nil, `{"tag_name":%q,"assets":[{"name":%q,"digest":%q,"size":%d,"state":%q,"browser_download_url":"https://example.net/malicious.pkg"}]}`,
						tt.releaseTag, tt.assetName, tt.digest, tt.filesize, tt.state)
					size = int64(len(response))
				case "https://github.com/yinniora/yugo-pi/releases/download/" + tag + "/" + asset:
					response, size = tt.body, tt.length
				default:
					t.Fatalf("unexpected request: %s", req.URL)
				}
				return &http.Response{StatusCode: http.StatusOK, ContentLength: size, Body: io.NopCloser(bytes.NewReader(response))}, nil
			})}
			file, err := downloadInstaller(context.Background(), client, release, HostInstaller, "darwin", "arm64", folder)
			if calls != tt.calls || (err == nil) != tt.want {
				t.Fatalf("unexpected outcome after %d calls: %+v, %v", calls, file, err)
			}
			entries, readErr := os.ReadDir(folder)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if !tt.want {
				if file.Path != "" || len(entries) != 0 {
					t.Fatalf("failed download left a staged file: %+v, %v", file, entries)
				}
				return
			}
			if file.Name != asset || filepath.Base(file.Path) != asset || file.Version != installerTestVersion || len(entries) != 1 ||
				!strings.HasPrefix(filepath.Base(filepath.Dir(file.Path)), "yugo-pi-update-"+file.Version+"-") {
				t.Fatalf("unexpected verified file: %+v", file)
			}
			contents, err := os.ReadFile(file.Path)
			if err != nil || !bytes.Equal(contents, original) {
				t.Fatalf("verified file content differs: %v", err)
			}
			installed, err := os.ReadDir(filepath.Dir(file.Path))
			if err != nil || len(installed) != 1 {
				t.Fatalf("unexpected files in staging: %v", installed)
			}
			if runtime.GOOS != "windows" {
				for _, path := range []string{file.Path, filepath.Dir(file.Path)} {
					stat, err := os.Stat(path)
					if err != nil || stat.Mode().Perm()&0077 != 0 {
						t.Fatalf("staging path has loose permissions: %v", err)
					}
				}
			}
		})
	}
}

func TestInstallerRedirectOnlyFollowsTrustedHTTPSGitHubHosts(t *testing.T) {
	for address, valid := range map[string]bool{
		"https://release-assets.githubusercontent.com/object": true,
		"https://objects.githubusercontent.com/object":        true,
		"https://github.com/object":                           true,
		"http://github.com/object":                            false,
		"https://github.com.example.org/object":               false,
		"https://github.com:8443/object":                      false,
		"https://somebody@github.com/object":                  false,
	} {
		request, err := http.NewRequest(http.MethodGet, address, nil)
		if err != nil {
			t.Fatal(err)
		}
		if (installerRedirect(request, nil) == nil) != valid {
			t.Errorf("unexpected redirect decision for %s", address)
		}
	}
}

type installerRoundTrip func(req *http.Request) (*http.Response, error)

func (f installerRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

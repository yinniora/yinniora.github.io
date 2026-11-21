package updater

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type InstallerRole string

const (
	HostInstaller           InstallerRole = "host"
	ClientInstaller         InstallerRole = "client"
	AppImageClientInstaller InstallerRole = "client-appimage"
	maxInstallerSize                      = 1 << 30
)

// InstallerDownload is a fully downloaded and verified installer. Its caller
// owns the private parent directory and can remove it after installation.
type InstallerDownload struct {
	Version string `json:"version"`
	Name    string `json:"name"`
	Path    string `json:"path"`
}

// InstallerAssetName maps a native installer role to the published asset for
// its exact CPU architecture and operating system.
func InstallerAssetName(version string, role InstallerRole, system, arch string) string {
	if !yuGoReleaseTag.MatchString("yugo-v"+version) || (arch != "amd64" && arch != "arm64") {
		return ""
	}
	if role == HostInstaller {
		return hostInstallerName(version, system, arch)
	}
	prefix := "yugo-pi-client-" + version + "-"
	archName := arch
	if arch == "amd64" {
		archName = "x64"
	}
	if role == AppImageClientInstaller && system == "linux" {
		if arch == "amd64" {
			archName = "x86_64"
		}
		return prefix + "linux-" + archName + ".AppImage"
	}
	if role != ClientInstaller {
		return ""
	}
	switch system {
	case "darwin":
		return prefix + "mac-" + archName + ".dmg"
	case "windows":
		return prefix + "windows-" + archName + "-setup.exe"
	case "linux":
		return prefix + "linux-" + arch + ".deb"
	default:
		return ""
	}
}

// DownloadInstaller downloads the checked YuGo version for the local platform.
// The only URL inputs are the fixed YuGo repository and a validated version.
// Callers must pass release metadata from their local updater, never from a
// remote device. Running the resulting file is a separate user action.
func DownloadInstaller(ctx context.Context, release YuGoRelease, role InstallerRole) (InstallerDownload, error) {
	client := &http.Client{Timeout: 5 * time.Minute, CheckRedirect: installerRedirect}
	return downloadInstaller(ctx, client, release, role, runtime.GOOS, runtime.GOARCH, os.TempDir())
}

func installerRedirect(request *http.Request, via []*http.Request) error {
	url := request.URL
	if len(via) < 5 && url.Scheme == "https" && url.User == nil && (url.Port() == "" || url.Port() == "443") {
		switch url.Hostname() {
		case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		}
	}
	return errors.New("unexpected YuGo installer download redirect")
}

func downloadInstaller(ctx context.Context, client *http.Client, release YuGoRelease, role InstallerRole, system, arch, temp string) (InstallerDownload, error) {
	asset := InstallerAssetName(release.Latest, role, system, arch)
	if !release.HasUpdate || asset == "" {
		return InstallerDownload{}, errors.New("no YuGo installer update is available for this platform")
	}
	tag := "yugo-v" + release.Latest
	metadata, err := verifiedInstallerMetadata(ctx, client, tag, asset)
	if err != nil {
		return InstallerDownload{}, err
	}
	directory, err := newInstallerDirectory(temp, "yugo-pi-update-"+release.Latest+"-")
	if err != nil {
		return InstallerDownload{}, errors.New("cannot create a private installer directory")
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(directory)
		}
	}()
	downloadURL := yuGoReleasePage + "/download/" + tag + "/" + asset
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return InstallerDownload{}, errors.New("cannot request the YuGo installer")
	}
	response, err := client.Do(request)
	if err != nil {
		return InstallerDownload{}, errors.New("could not download the YuGo installer")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || (response.ContentLength >= 0 && response.ContentLength != metadata.Size) {
		return InstallerDownload{}, errors.New("the YuGo installer download returned an unexpected response")
	}
	partial, err := os.CreateTemp(directory, ".download-")
	if err != nil {
		return InstallerDownload{}, errors.New("cannot save the YuGo installer")
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(partial, digest), io.LimitReader(response.Body, metadata.Size+1))
	if copyErr != nil || written != metadata.Size || subtle.ConstantTimeCompare(digest.Sum(nil), metadata.Digest) != 1 {
		_ = partial.Close()
		return InstallerDownload{}, errors.New("the YuGo installer download failed its size or SHA-256 check")
	}
	if role == AppImageClientInstaller {
		if err := partial.Chmod(0700); err != nil {
			_ = partial.Close()
			return InstallerDownload{}, errors.New("cannot prepare the verified YuGo AppImage")
		}
	}
	syncErr := partial.Sync()
	closeErr := partial.Close()
	if syncErr != nil || closeErr != nil {
		return InstallerDownload{}, errors.New("cannot save the verified YuGo installer")
	}
	if err := markInstallerDownload(partial.Name()); err != nil {
		return InstallerDownload{}, errors.New("cannot mark the verified YuGo installer as a download")
	}
	path := filepath.Join(directory, asset)
	if err := os.Rename(partial.Name(), path); err != nil {
		return InstallerDownload{}, errors.New("cannot finish saving the verified YuGo installer")
	}
	complete = true
	return InstallerDownload{Version: release.Latest, Name: asset, Path: path}, nil
}

type installerMetadata struct {
	Digest []byte
	Size   int64
}

func verifiedInstallerMetadata(ctx context.Context, client *http.Client, tag, asset string) (installerMetadata, error) {
	unavailable := errors.New("verified metadata is unavailable for this YuGo installer")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, defaultGitHubAPI+"/releases/tags/"+tag, nil)
	if err != nil {
		return installerMetadata{}, unavailable
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := client.Do(request)
	if err != nil {
		return installerMetadata{}, unavailable
	}
	defer response.Body.Close()
	const limit = 2 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || response.StatusCode != http.StatusOK || len(body) > limit {
		return installerMetadata{}, unavailable
	}
	var release struct {
		Tag    string `json:"tag_name"`
		Draft  bool   `json:"draft"`
		Assets []struct {
			Name   string `json:"name"`
			Digest string `json:"digest"`
			State  string `json:"state"`
			Size   int64  `json:"size"`
		} `json:"assets"`
	}
	if json.Unmarshal(body, &release) != nil || release.Draft || release.Tag != tag {
		return installerMetadata{}, unavailable
	}
	var metadata installerMetadata
	for _, candidate := range release.Assets {
		if candidate.Name != asset {
			continue
		}
		const prefix = "sha256:"
		if metadata.Digest != nil || candidate.State != "uploaded" || candidate.Size <= 0 || candidate.Size > maxInstallerSize ||
			len(candidate.Digest) != len(prefix)+sha256.Size*2 || candidate.Digest[:len(prefix)] != prefix {
			return installerMetadata{}, unavailable
		}
		digest, err := hex.DecodeString(candidate.Digest[len(prefix):])
		if err != nil {
			return installerMetadata{}, unavailable
		}
		metadata = installerMetadata{Digest: digest, Size: candidate.Size}
	}
	if metadata.Digest == nil {
		return installerMetadata{}, unavailable
	}
	return metadata, nil
}

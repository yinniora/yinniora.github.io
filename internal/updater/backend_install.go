package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"debug/elf"
	"debug/macho"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	backendManifestAsset       = "yugo-backend-compatibility.json"
	backendCompatibility       = 1
	maximumReleaseMetadataSize = 2 << 20
	maximumBackendManifestSize = 4 << 10
	maximumBackendArchiveSize  = 80 << 20
	maximumBackendBinarySize   = 128 << 20
	maximumBackendExpandedSize = maximumBackendBinarySize + (4 << 20)
)

var backendUpdateLock sync.Mutex

var ErrFullInstallerRequired = errors.New("this host requires the full installer")

var errReleaseAssetMissing = errors.New("release asset was not published")

type backendReleaseAsset struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

// BackendUpdateSupported identifies standalone, user-writable binaries. Signed
// app bundles and package-managed system executables use the full installer.
func BackendUpdateSupported(executable string) bool {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return false
	}
	_, _, err := backendTarget(executable)
	return err == nil
}

// InstallBackend verifies and prepares the exact requested release from the
// public YuGo repository before replacing the running standalone executable.
// The caller owns service restart and must have prevented new work from starting.
func InstallBackend(ctx context.Context, executable, current, target string) (previous string, err error) {
	if !BackendUpdateSupported(executable) {
		return "", ErrFullInstallerRequired
	}
	client := &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil ||
				(req.URL.Port() != "" && req.URL.Port() != "443") {
				return errors.New("unsafe release download redirect")
			}
			switch req.URL.Hostname() {
			case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com":
				return nil
			default:
				return errors.New("unsafe release download redirect")
			}
		},
	}
	return installBackend(ctx, executable, current, target, client, verifyBackendVersion)
}

func backendTarget(executable string) (string, os.FileInfo, error) {
	if !filepath.IsAbs(executable) || filepath.Base(executable) != "pi-web" {
		return "", nil, errors.New("the standalone host path is invalid")
	}
	info, err := os.Lstat(executable)
	if err != nil {
		return "", nil, err
	}
	actual, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", nil, err
	}
	dir := filepath.Dir(actual)
	for _, candidate := range []string{executable, actual} {
		for _, part := range strings.Split(candidate, string(os.PathSeparator)) {
			if strings.HasSuffix(strings.ToLower(part), ".app") {
				return "", nil, errors.New("the host is installed in an app bundle")
			}
		}
	}
	parent, err := os.Stat(dir)
	if err != nil {
		return "", nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0100 == 0 || info.Mode().Perm()&0022 != 0 ||
		!backendOwnedByUser(info) || !parent.IsDir() || parent.Mode().Perm()&0300 != 0300 ||
		parent.Mode().Perm()&0022 != 0 || !backendOwnedByUser(parent) {
		return "", nil, errors.New("the host binary and directory must be user-owned and private to write")
	}
	for ancestor := filepath.Dir(dir); ; ancestor = filepath.Dir(ancestor) {
		info, err := os.Lstat(ancestor)
		if err != nil || !info.IsDir() || !backendOwnedByUserOrRoot(info) ||
			(info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0) {
			return "", nil, errors.New("the host directory has an unsafe parent")
		}
		if filepath.Dir(ancestor) == ancestor {
			break
		}
	}
	return actual, info, nil
}

func installBackend(ctx context.Context, executable, current, target string, client *http.Client, verify func(context.Context, string, string) error) (string, error) {
	tag := "yugo-v" + target
	if len(current) > 64 || len(target) > 64 || !yuGoReleaseTag.MatchString("yugo-v"+current) ||
		!yuGoReleaseTag.MatchString(tag) || compareSemver(target, current) <= 0 {
		return "", errors.New("the backend update must be a newer YuGo release")
	}
	backendUpdateLock.Lock()
	defer backendUpdateLock.Unlock()
	path, currentInfo, err := backendTarget(executable)
	if err != nil {
		return "", err
	}
	apiURL := defaultGitHubAPI + "/releases/tags/" + tag
	metadata, err := readReleaseMetadata(ctx, client, apiURL)
	if err != nil {
		return "", fmt.Errorf("fetch backend release metadata: %w", err)
	}
	var release struct {
		Draft  bool                  `json:"draft"`
		Tag    string                `json:"tag_name"`
		Assets []backendReleaseAsset `json:"assets"`
	}
	if err = json.Unmarshal(metadata, &release); err != nil || release.Draft || release.Tag != tag {
		return "", errors.New("GitHub returned an invalid backend release")
	}
	binaryAsset := "yugo-pi-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
	manifest, err := findBackendAsset(release.Assets, backendManifestAsset, maximumBackendManifestSize)
	if err != nil {
		if errors.Is(err, errReleaseAssetMissing) {
			return "", fmt.Errorf("%w: backend compatibility is not declared", ErrFullInstallerRequired)
		}
		return "", err
	}
	archive, err := findBackendAsset(release.Assets, binaryAsset, maximumBackendArchiveSize)
	if err != nil {
		return "", err
	}
	var compatibility bytes.Buffer
	if err = verifiedBackendDownload(ctx, client, tag, manifest, &compatibility); err != nil {
		return "", fmt.Errorf("verify backend compatibility manifest: %w", err)
	}
	var format struct {
		Compatibility *int `json:"backendCompatibility"`
	}
	if err = json.Unmarshal(compatibility.Bytes(), &format); err != nil || format.Compatibility == nil {
		return "", errors.New("the backend compatibility manifest is invalid")
	}
	if *format.Compatibility != backendCompatibility {
		return "", fmt.Errorf("%w: backend compatibility has changed", ErrFullInstallerRequired)
	}

	staging, err := os.MkdirTemp(filepath.Dir(path), ".yugo-update-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	compressed, err := os.OpenFile(filepath.Join(staging, "archive.tar.gz"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer compressed.Close()
	if err = verifiedBackendDownload(ctx, client, tag, archive, compressed); err != nil {
		return "", fmt.Errorf("verify backend archive: %w", err)
	}
	if _, err = compressed.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	replacement := filepath.Join(staging, "pi-web")
	if err = extractBackend(compressed, replacement, currentInfo.Mode().Perm()); err != nil {
		return "", err
	}
	if err = verify(ctx, replacement, target); err != nil {
		return "", err
	}

	if err = ctx.Err(); err != nil {
		return "", err
	}
	_, actualInfo, err := backendTarget(path)
	if err != nil || !os.SameFile(actualInfo, currentInfo) ||
		actualInfo.Size() != currentInfo.Size() || !actualInfo.ModTime().Equal(currentInfo.ModTime()) {
		return "", errors.New("the running host binary changed during the update")
	}
	previous := path + ".previous"
	backup := filepath.Join(staging, "previous")
	if err = os.Link(path, backup); err != nil {
		return "", fmt.Errorf("preserve the previous backend: %w", err)
	}
	if err = os.Rename(backup, previous); err != nil {
		return "", fmt.Errorf("save the previous backend: %w", err)
	}
	if err = os.Rename(replacement, path); err != nil {
		return "", fmt.Errorf("replace the backend: %w", err)
	}
	syncBackendDirectory(path)
	return previous, nil
}

// RollbackBackend restores the previous binary created by InstallBackend.
// The caller can rerun the original service only after this returns success.
func RollbackBackend(ctx context.Context, executable, previous, expectedVersion string) error {
	if !BackendUpdateSupported(executable) {
		return ErrFullInstallerRequired
	}
	return rollbackBackend(ctx, executable, previous, expectedVersion, verifyBackendVersion)
}

func rollbackBackend(ctx context.Context, executable, previous, expectedVersion string, verify func(context.Context, string, string) error) error {
	backendUpdateLock.Lock()
	defer backendUpdateLock.Unlock()
	path, _, err := backendTarget(executable)
	if err != nil {
		return err
	}
	if previous != path+".previous" {
		return errors.New("the backend rollback path is invalid")
	}
	info, err := os.Lstat(previous)
	if err != nil || !info.Mode().IsRegular() || !backendOwnedByUser(info) ||
		info.Mode().Perm()&0100 == 0 || info.Mode().Perm()&0022 != 0 {
		return errors.New("the previous backend is not a trusted local executable")
	}
	if err = verify(ctx, previous, expectedVersion); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(path), ".yugo-rollback-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	candidate := filepath.Join(staging, "pi-web")
	if err = os.Link(previous, candidate); err != nil {
		return err
	}
	if err = os.Rename(candidate, path); err != nil {
		return err
	}
	syncBackendDirectory(path)
	return nil
}

func syncBackendDirectory(path string) {
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}

func readReleaseMetadata(ctx context.Context, client *http.Client, endpoint string) ([]byte, error) {
	body, err := requestBackendRelease(ctx, client, endpoint, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, maximumReleaseMetadataSize+1))
	if err != nil || len(raw) > maximumReleaseMetadataSize {
		return nil, errors.New("invalid backend release metadata size")
	}
	return raw, nil
}

func requestBackendRelease(ctx context.Context, client *http.Client, endpoint, accept string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "YuGo-Pi-backend-updater")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("could not reach the YuGo release service")
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("YuGo release service returned HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func findBackendAsset(assets []backendReleaseAsset, name string, maxSize int64) (backendReleaseAsset, error) {
	var result backendReleaseAsset
	for _, asset := range assets {
		if asset.Name != name {
			continue
		}
		encoded, ok := strings.CutPrefix(asset.Digest, "sha256:")
		digest, err := hex.DecodeString(encoded)
		if result.Name != "" || asset.State != "uploaded" || asset.Size <= 0 || asset.Size > maxSize ||
			!ok || err != nil || len(digest) != sha256.Size {
			return backendReleaseAsset{}, fmt.Errorf("invalid release metadata for %s", name)
		}
		result = asset
	}
	if result.Name == "" {
		return backendReleaseAsset{}, fmt.Errorf("%w: %s", errReleaseAssetMissing, name)
	}
	return result, nil
}

func verifiedBackendDownload(ctx context.Context, client *http.Client, tag string, asset backendReleaseAsset, output io.Writer) error {
	body, err := requestBackendRelease(ctx, client, yuGoReleasePage+"/download/"+tag+"/"+asset.Name, "application/octet-stream")
	if err != nil {
		return err
	}
	defer body.Close()
	checksum := sha256.New()
	written, err := io.Copy(io.MultiWriter(output, checksum), io.LimitReader(body, asset.Size+1))
	if err != nil {
		return err
	}
	expected, _ := hex.DecodeString(strings.TrimPrefix(asset.Digest, "sha256:"))
	if written != asset.Size || subtle.ConstantTimeCompare(checksum.Sum(nil), expected) != 1 {
		return errors.New("the downloaded asset differs from its published SHA-256 digest or size")
	}
	return nil
}

func extractBackend(compressed io.Reader, destination string, mode os.FileMode) error {
	expanded, err := gzip.NewReader(compressed)
	if err != nil {
		return err
	}
	defer expanded.Close()
	limited := &io.LimitedReader{R: expanded, N: maximumBackendExpandedSize}
	archive := tar.NewReader(limited)
	found := false
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || header.Size <= 0 {
			return errors.New("the backend archive contains an unexpected entry")
		}
		switch header.Name {
		case "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES":
			if header.Size > 2<<20 {
				return errors.New("the backend archive contains oversized notices")
			}
		case "pi-web":
			if found || header.Size > maximumBackendBinarySize {
				return errors.New("the backend archive contains an invalid executable")
			}
			found = true
			out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, archive)
			// Apply the existing executable mode to the verified candidate.
			if err == nil {
				err = out.Chmod(mode)
			}
			if err == nil {
				err = out.Sync()
			}
			if closeErr := out.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return err
			}
		default:
			return errors.New("the backend archive contains an unexpected path")
		}
	}
	if _, err = io.Copy(io.Discard, limited); err != nil {
		return err
	}
	if !found || limited.N == 0 {
		return errors.New("the backend archive is incomplete or oversized")
	}
	return nil
}

func verifyBackendVersion(ctx context.Context, path, target string) error {
	valid := false
	switch runtime.GOOS {
	case "darwin":
		binary, err := macho.Open(path)
		if err == nil {
			defer binary.Close()
			valid = binary.Type == macho.TypeExec &&
				((runtime.GOARCH == "arm64" && binary.Cpu == macho.CpuArm64) ||
					(runtime.GOARCH == "amd64" && binary.Cpu == macho.CpuAmd64))
		}
	case "linux":
		binary, err := elf.Open(path)
		if err == nil {
			defer binary.Close()
			valid = (binary.Type == elf.ET_EXEC || binary.Type == elf.ET_DYN) &&
				((runtime.GOARCH == "arm64" && binary.Machine == elf.EM_AARCH64) ||
					(runtime.GOARCH == "amd64" && binary.Machine == elf.EM_X86_64))
		}
	}
	if !valid {
		return errors.New("the backend executable does not match this host")
	}
	probe, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probe, path, "-version")
	cmd.Env = []string{}
	body, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(body)) != target {
		return errors.New("the downloaded backend did not identify as the requested version")
	}
	return nil
}

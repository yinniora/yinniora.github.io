package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testCurrentBackend = "0.1.0-yugo.61"
	testTargetBackend  = "0.1.0-yugo.62"
)

type backendTestTransport func(*http.Request) (*http.Response, error)

func (transport backendTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func backendTestArchive(t *testing.T, entry string, kind byte, data string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	zipper := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(zipper)
	header := &tar.Header{Name: entry, Typeflag: kind, Mode: 0755, Size: int64(len(data))}
	if kind == tar.TypeSymlink {
		header.Size = 0
		header.Linkname = data
	}
	if err := writer.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if kind != tar.TypeSymlink {
		if _, err := io.WriteString(writer, data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipper.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func backendReleaseFixture(t *testing.T, archive, manifest []byte, edit func([]backendReleaseAsset) []backendReleaseAsset) *http.Client {
	t.Helper()
	tag := "yugo-v" + testTargetBackend
	assetName := "yugo-pi-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
	assets := []backendReleaseAsset{
		{Name: backendManifestAsset, State: "uploaded", Size: int64(len(manifest)), Digest: fmt.Sprintf("sha256:%x", sha256.Sum256(manifest))},
		{Name: assetName, State: "uploaded", Size: int64(len(archive)), Digest: fmt.Sprintf("sha256:%x", sha256.Sum256(archive))},
	}
	if edit != nil {
		assets = edit(assets)
	}
	release, err := json.Marshal(map[string]any{"tag_name": tag, "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: backendTestTransport(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.Header.Get("Authorization") != "" {
			t.Fatal("unexpected request headers", request.Method, request.Header)
		}
		var body []byte
		switch request.URL.String() {
		case defaultGitHubAPI + "/releases/tags/" + tag:
			body = release
		case yuGoReleasePage + "/download/" + tag + "/" + backendManifestAsset:
			body = manifest
		case yuGoReleasePage + "/download/" + tag + "/" + assetName:
			body = archive
		default:
			return nil, fmt.Errorf("unexpected request %s", request.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
}

func TestInstallBackendRetainsWorkingBinaryUntilVerified(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("standalone binary replacement requires POSIX semantics")
	}
	standardArchive := backendTestArchive(t, "pi-web", tar.TypeReg, "new backend")
	for _, tc := range []struct {
		name          string
		archive       []byte
		compatibility string
		edit          func([]backendReleaseAsset) []backendReleaseAsset
		failVersion   bool
		cancelProbe   bool
		wantError     bool
		fullInstaller bool
		versionCalled bool
	}{
		{name: "verified replacement", archive: standardArchive, versionCalled: true},
		{name: "published digest missing", archive: standardArchive, edit: func(assets []backendReleaseAsset) []backendReleaseAsset {
			assets[1].Digest = ""
			return assets
		}, wantError: true},
		{name: "previous release did not declare compatibility", archive: standardArchive, edit: func(assets []backendReleaseAsset) []backendReleaseAsset {
			return assets[1:]
		}, wantError: true, fullInstaller: true},
		{name: "marker has no verified digest", archive: standardArchive, edit: func(assets []backendReleaseAsset) []backendReleaseAsset {
			assets[0].Digest = ""
			return assets
		}, wantError: true},
		{name: "bytes differ from published digest", archive: standardArchive, edit: func(assets []backendReleaseAsset) []backendReleaseAsset {
			assets[1].Digest = "sha256:" + strings.Repeat("00", 32)
			return assets
		}, wantError: true},
		{name: "declared bytes too small", archive: standardArchive, edit: func(assets []backendReleaseAsset) []backendReleaseAsset {
			assets[1].Size--
			return assets
		}, wantError: true},
		{name: "release needs full installer", archive: standardArchive, compatibility: fmt.Sprintf(`{"backendCompatibility":%d}`, backendCompatibility+1), wantError: true, fullInstaller: true},
		{name: "marker is invalid", archive: standardArchive, compatibility: `{}`, wantError: true},
		{name: "archive attempts path escape", archive: backendTestArchive(t, "../pi-web", tar.TypeReg, "new backend"), wantError: true},
		{name: "archive executable is a link", archive: backendTestArchive(t, "pi-web", tar.TypeSymlink, "../pi-web"), wantError: true},
		{name: "executable version differs", archive: standardArchive, failVersion: true, versionCalled: true, wantError: true},
		{name: "update canceled before replacement", archive: standardArchive, cancelProbe: true, versionCalled: true, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dst := filepath.Join(t.TempDir(), "pi-web")
			if err := os.WriteFile(dst, []byte("working backend"), 0750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(dst+".previous", []byte("earlier backup"), 0750); err != nil {
				t.Fatal(err)
			}
			manifest := tc.compatibility
			if manifest == "" {
				manifest = fmt.Sprintf(`{"backendCompatibility":%d}`, backendCompatibility)
			}
			client := backendReleaseFixture(t, tc.archive, []byte(manifest), tc.edit)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var versionCalled bool
			previous, err := installBackend(ctx, dst, testCurrentBackend, testTargetBackend, client, func(_ context.Context, staged, target string) error {
				versionCalled = true
				actual, err := os.ReadFile(staged)
				if err != nil || string(actual) != "new backend" || target != testTargetBackend {
					t.Fatal("the staged backend or target is invalid", string(actual), target, err)
				}
				if tc.cancelProbe {
					cancel()
				}
				if tc.failVersion {
					return errors.New("unexpected version")
				}
				return nil
			})
			if (err != nil) != tc.wantError || versionCalled != tc.versionCalled ||
				errors.Is(err, ErrFullInstallerRequired) != tc.fullInstaller {
				t.Fatalf("installer error %v, ran verification %v", err, versionCalled)
			}
			binary, _ := os.ReadFile(dst)
			backup, _ := os.ReadFile(dst + ".previous")
			if tc.wantError {
				if string(binary) != "working backend" || string(backup) != "earlier backup" || previous != "" {
					t.Fatal("failed update changed a managed binary")
				}
			} else if string(binary) != "new backend" || string(backup) != "working backend" || !strings.HasSuffix(previous, "pi-web.previous") {
				t.Fatal("verified update did not replace the backend and preserve a backup")
			}
			info, err := os.Stat(dst)
			if err != nil || info.Mode().Perm() != 0750 {
				t.Fatal("backend mode changed", err)
			}
			entries, err := filepath.Glob(filepath.Join(filepath.Dir(dst), ".yugo-update-*"))
			if err != nil || len(entries) != 0 {
				t.Fatal("staging files were left behind", err)
			}
		})
	}
}

func TestBackendRollbackUsesVerifiedPreviousBinary(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("standalone binary replacement requires POSIX semantics")
	}
	dst := filepath.Join(t.TempDir(), "pi-web")
	if err := os.WriteFile(dst, []byte("current backend"), 0700); err != nil {
		t.Fatal(err)
	}
	actual, err := filepath.EvalSymlinks(dst)
	if err != nil {
		t.Fatal(err)
	}
	previous := actual + ".previous"
	if err = os.WriteFile(previous, []byte("previous backend"), 0700); err != nil {
		t.Fatal(err)
	}
	verified := false
	verify := func(_ context.Context, path, version string) error {
		verified = true
		if path != previous || version != testCurrentBackend {
			return errors.New("wrong rollback target")
		}
		return nil
	}
	if err = rollbackBackend(context.Background(), dst, actual+".other", testCurrentBackend, verify); err == nil || verified {
		t.Fatal("rollback accepted an unrelated executable")
	}
	if err = rollbackBackend(context.Background(), dst, previous, testCurrentBackend, verify); err != nil || !verified {
		t.Fatal("rollback of the previous backend failed:", err)
	}
	binary, _ := os.ReadFile(dst)
	backup, _ := os.ReadFile(previous)
	if string(binary) != "previous backend" || string(backup) != "previous backend" {
		t.Fatal("rollback did not restore the working binary and retain its backup")
	}
}

func TestBackendUpdateRejectsSignedBundleAndNonExecutables(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "YuGo Pi.app", "Contents", "Resources", "pi-web")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("example"), 0700); err != nil {
		t.Fatal(err)
	}
	if BackendUpdateSupported(path) {
		t.Fatal("accepted a backend inside the application bundle")
	}
	if err := verifyBackendVersion(context.Background(), path, testTargetBackend); err == nil {
		t.Fatal("accepted an executable without a format matching the current machine")
	}
}

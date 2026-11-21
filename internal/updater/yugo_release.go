package updater

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const yuGoReleasePage = "https://github.com/yinniora/yugo-pi/releases"

var yuGoReleaseTag = regexp.MustCompile(`^yugo-v\d+\.\d+\.\d+-yugo\.\d+$`)

type YuGoRelease struct {
	Latest      string `json:"latest"`
	HasUpdate   bool   `json:"hasUpdate"`
	URL         string `json:"url"`
	DownloadURL string `json:"downloadUrl,omitempty"`
	CheckedAt   string `json:"checkedAt,omitempty"`
	Error       string `json:"error,omitempty"`
}

func NewYuGoTracking(version string) *Checker {
	c := NewTracking(version)
	c.checkYuGo = true
	c.yugoRelease = YuGoRelease{URL: yuGoReleasePage}
	return c
}

func (c *Checker) checkTrackedReleases(ctx context.Context) (Info, error) {
	upstream := make(chan error, 1)
	go func() {
		_, err := c.checkUpstream(ctx)
		upstream <- err
	}()
	releaseErr := c.refreshYuGoRelease(ctx)
	upstreamErr := <-upstream
	if upstreamErr != nil && releaseErr != nil {
		return c.Info(), errors.Join(upstreamErr, releaseErr)
	}
	return c.Info(), nil
}

func (c *Checker) refreshYuGoRelease(ctx context.Context) error {
	if c.isDev() {
		return nil
	}
	latest, err := c.latestYuGoRelease(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.yugoRelease.Error = "YuGo releases could not be checked"
		return err
	}
	c.yugoRelease = latest
	return nil
}

func (c *Checker) latestYuGoRelease(ctx context.Context) (YuGoRelease, error) {
	data, err := c.get(ctx, c.githubAPI+"/releases?per_page=10", "")
	if err != nil {
		return YuGoRelease{}, err
	}
	var releases []struct {
		Tag    string                  `json:"tag_name"`
		Draft  bool                    `json:"draft"`
		Assets []struct{ Name string } `json:"assets"`
	}
	if err := json.Unmarshal(data, &releases); err != nil {
		return YuGoRelease{}, err
	}
	latest := YuGoRelease{URL: yuGoReleasePage, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	for _, release := range releases {
		if release.Draft || !yuGoReleaseTag.MatchString(release.Tag) {
			continue
		}
		version := strings.TrimPrefix(release.Tag, "yugo-v")
		if latest.Latest != "" && compareSemver(version, latest.Latest) <= 0 {
			continue
		}
		latest.Latest = version
		latest.HasUpdate = compareSemver(version, c.current) > 0
		latest.URL = yuGoReleasePage + "/tag/" + release.Tag
		latest.DownloadURL = ""
		asset := hostInstallerName(version, runtime.GOOS, runtime.GOARCH)
		for _, candidate := range release.Assets {
			if candidate.Name == asset && asset != "" {
				latest.DownloadURL = yuGoReleasePage + "/download/" + release.Tag + "/" + url.PathEscape(asset)
				break
			}
		}
	}
	return latest, nil
}

func hostInstallerName(version, system, arch string) string {
	electronArch := arch
	if arch == "amd64" {
		electronArch = "x64"
	}
	prefix := "yugo-pi-host-" + version
	switch system {
	case "darwin":
		return prefix + "-macos-" + electronArch + ".pkg"
	case "linux":
		return prefix + "-linux-" + arch + ".deb"
	case "windows":
		return prefix + "-windows-" + electronArch + "-setup.exe"
	default:
		return ""
	}
}

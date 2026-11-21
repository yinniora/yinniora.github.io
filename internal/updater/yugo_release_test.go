package updater

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

func TestYuGoTrackingUsesPublishedVersionWithOwnInstaller(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "never-sent")
	installer := hostInstallerName("0.1.0-yugo.102", runtime.GOOS, runtime.GOARCH)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("release tracking used a token")
		}
		switch r.URL.Path {
		case "/commits/main":
			http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
		case "/releases":
			fmt.Fprintf(w, `[{"tag_name":"yugo-v0.1.0-yugo.99"},{"tag_name":"yugo-v0.1.0-yugo.102","assets":[{"name":%q}]},{"tag_name":"yugo-v0.1.0-yugo.103","draft":true},{"tag_name":"external-v9.0.0"}]`, installer)
		default:
			t.Errorf("unexpected URL %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	checker := NewYuGoTracking("0.1.0-yugo.100")
	checker.githubAPI, checker.upstreamAPI = api.URL, api.URL
	info, err := checker.Check(context.Background())
	if err != nil || !info.TrackingOnly || info.YuGoRelease == nil || !info.YuGoRelease.HasUpdate || info.YuGoRelease.Latest != "0.1.0-yugo.102" || info.Upstream.Error == "" {
		t.Fatalf("unexpected release result %+v %v", info, err)
	}
	if installer != "" && !strings.HasSuffix(info.YuGoRelease.DownloadURL, "/"+installer) {
		t.Fatalf("missing trusted installer link: %s", info.YuGoRelease.DownloadURL)
	}
}

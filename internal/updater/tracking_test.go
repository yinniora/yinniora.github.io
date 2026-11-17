package updater

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTrackingRemindsWithoutAdvertisingAnInstall(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "must-not-leave-this-process")
	latest := strings.Repeat("b", 40)
	failed := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/commits/main" || r.Header.Get("Authorization") != "" {
			t.Errorf("tracking exceeded public metadata boundary: %s %s", r.Method, r.URL.Path)
		}
		if failed {
			w.WriteHeader(503)
			return
		}
		fmt.Fprintf(w, `{"sha":%q}`, latest)
	}))
	defer server.Close()
	c := NewTracking("0.1.0-yugo.2")
	c.upstreamAPI = server.URL
	info, err := c.Check(context.Background())
	if err != nil || !info.TrackingOnly || info.HasUpdate || info.Latest != "" || !info.Upstream.HasUpdate || !c.manual {
		t.Fatalf("tracking became an install offer: %+v %v", info, err)
	}
	if info.Upstream.URL != officialRepository+"/compare/"+info.Upstream.Base+"..."+latest {
		t.Fatal("untrusted comparison URL")
	}
	checkedAt := info.CheckedAt
	failed = true
	info, err = c.Check(context.Background())
	if err == nil || !info.Upstream.HasUpdate || info.Upstream.Latest != latest || info.CheckedAt != checkedAt || info.Upstream.Error == "" {
		t.Fatal("failed check erased a pending reminder or claimed a successful refresh")
	}
	failed = false
	latest = info.Upstream.Base
	info, err = c.Check(context.Background())
	if err != nil || info.Upstream.HasUpdate || info.Upstream.Error != "" {
		t.Fatal("integrated official commit should be current")
	}
}

func TestTrackingRejectsInvalidCommitMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"sha":"https://untrusted.example/install"}`))
	}))
	defer server.Close()
	c := NewTracking("dev")
	c.upstreamAPI = server.URL
	info, err := c.Check(context.Background())
	if err == nil || info.Upstream.HasUpdate || info.Upstream.Latest != "" || info.CheckedAt != "" {
		t.Fatal("invalid commit created an update reminder")
	}
}

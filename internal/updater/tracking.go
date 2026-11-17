package updater

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

//go:embed upstream-base.txt
var integratedUpstream string

const officialRepository = "https://github.com/ygncode/pi-web"

type UpstreamInfo struct {
	Base      string `json:"base"`
	Latest    string `json:"latest"`
	HasUpdate bool   `json:"hasUpdate"`
	URL       string `json:"url"`
	Error     string `json:"error,omitempty"`
}

// NewTracking observes public official commits without installing, merging,
// running code, or using any GitHub/model/device credential.
func NewTracking(version string) *Checker {
	c := NewManual(version)
	c.tracking = true
	c.upstreamAPI = "https://api.github.com/repos/ygncode/pi-web"
	c.upstream = UpstreamInfo{Base: strings.TrimSpace(integratedUpstream), URL: officialRepository}
	return c
}

var commitSHA = regexp.MustCompile(`^[a-f0-9]{40}$`)

func (c *Checker) checkUpstream(ctx context.Context) (Info, error) {
	body, err := c.get(ctx, c.upstreamAPI+"/commits/main", "")
	var commit struct {
		SHA string `json:"sha"`
	}
	if err == nil {
		err = json.Unmarshal(body, &commit)
		if err == nil && !commitSHA.MatchString(commit.SHA) {
			err = fmt.Errorf("invalid official commit response")
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		// Keep the last known reminder and success time on transient failures.
		c.upstream.Error = "Official update check is temporarily unavailable"
		return c.snapshotLocked(), err
	}
	c.upstream.Error = ""
	c.upstream.Latest = commit.SHA
	c.upstream.HasUpdate = commit.SHA != c.upstream.Base
	c.upstream.URL = officialRepository + "/compare/" + c.upstream.Base + "..." + commit.SHA
	c.checkedAt = time.Now()
	return c.snapshotLocked(), nil
}

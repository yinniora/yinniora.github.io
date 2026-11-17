//go:build !darwin

package server

import (
	"io/fs"
	"time"
)

// No trustworthy portable creation time: preserve files on these systems.
func cleanupBirthTime(fs.FileInfo) time.Time { return time.Time{} }

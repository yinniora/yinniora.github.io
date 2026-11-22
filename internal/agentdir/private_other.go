//go:build !unix

package agentdir

import "os"

// On Windows Go's permission mode only controls the read-only attribute.
// Keep the account and user-selected directory ACLs intact.
func protectFileMode(_ *os.File, _ os.FileInfo, _ os.FileMode) error { return nil }

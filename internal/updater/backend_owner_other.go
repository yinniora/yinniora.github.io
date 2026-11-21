//go:build !unix

package updater

import "os"

func backendOwnedByUser(os.FileInfo) bool { return false }

func backendOwnedByUserOrRoot(os.FileInfo) bool { return false }

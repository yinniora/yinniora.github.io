package rpc

import _ "embed"

//go:embed task_checkpoint.mjs
var taskCheckpoint []byte

func InstallTaskCheckpoint(dir string) (string, error) {
	return installWorkerExtension(dir, "yugo-task-checkpoint.mjs", taskCheckpoint)
}

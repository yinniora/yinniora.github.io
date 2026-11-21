package picmd

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCommandUsesPackagedNodeDirectly(t *testing.T) {
	runtime := t.TempDir()
	node := filepath.Join(runtime, "bundled node")
	cli := filepath.Join(runtime, "pi cli.js")
	t.Setenv("PI_WEB_PI_NODE", node)
	t.Setenv("PI_WEB_PI_SCRIPT", cli)
	cmd := Command(context.Background(), "--mode", "rpc")
	if want := []string{node, cli, "--mode", "rpc"}; cmd.Err != nil || !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("command = %v, err = %v", cmd.Args, cmd.Err)
	}
}

func TestCommandRequiresBothPackagedPaths(t *testing.T) {
	t.Setenv("PI_WEB_PI_NODE", filepath.Join(t.TempDir(), "node"))
	t.Setenv("PI_WEB_PI_SCRIPT", "")
	if cmd := Command(context.Background()); cmd.Err == nil {
		t.Fatal("accepted a partially configured Pi runtime")
	}
}

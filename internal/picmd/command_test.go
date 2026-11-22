package picmd

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestCommandUsesPackagedNodeDirectly(t *testing.T) {
	runtime := t.TempDir()
	node := filepath.Join(runtime, "bundled node.exe")
	if err := os.WriteFile(node, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(runtime, "pi cli.js")
	t.Setenv("PI_WEB_PI_NODE", node)
	t.Setenv("PI_WEB_PI_SCRIPT", cli)
	cmd := Command(context.Background(), runtime, "--mode", "rpc")
	if want := []string{node, cli, "--mode", "rpc"}; cmd.Err != nil || !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("command = %v, err = %v", cmd.Args, cmd.Err)
	}
}

func TestCommandRequiresBothPackagedPaths(t *testing.T) {
	t.Setenv("PI_WEB_PI_NODE", filepath.Join(t.TempDir(), "node"))
	t.Setenv("PI_WEB_PI_SCRIPT", "")
	if cmd := Command(context.Background(), ""); cmd.Err == nil {
		t.Fatal("accepted a partially configured Pi runtime")
	}
}

func TestCommandKeepsServiceRelayCredentialsOutOfChildEnvironment(t *testing.T) {
	for _, key := range []string{"PI_WEB_RELAY_HOST_TOKEN", "PI_WEB_REMOTE_TURN_SECRET", "pi_web_relay_client_secret"} {
		t.Setenv(key, "service-credential-fixture")
	}
	t.Setenv("PI_WEB_TOKEN", "local-api-fixture")
	t.Setenv("ANTHROPIC_API_KEY", "provider-fixture")
	dir := t.TempDir()
	cmd := Command(context.Background(), dir, "--mode", "rpc")
	if cmd.Dir != dir {
		t.Fatal("command lost its working directory")
	}
	if slices.ContainsFunc(cmd.Env, func(entry string) bool {
		return strings.HasSuffix(entry, "=service-credential-fixture")
	}) {
		t.Fatal("Pi inherited a server credential")
	}
	for _, entry := range []string{"PI_WEB_TOKEN=local-api-fixture", "ANTHROPIC_API_KEY=provider-fixture"} {
		if !slices.Contains(cmd.Env, entry) {
			t.Fatal("Pi lost a credential used by its runtime")
		}
	}
}

func TestCommandDisablesInstallTelemetry(t *testing.T) {
	t.Setenv("PI_TELEMETRY", "1")
	cmd := Command(context.Background(), t.TempDir(), "--mode", "rpc")
	var telemetry []string
	for _, entry := range cmd.Env {
		if strings.HasPrefix(strings.ToUpper(entry), "PI_TELEMETRY=") {
			telemetry = append(telemetry, entry)
		}
	}
	if !slices.Equal(telemetry, []string{"PI_TELEMETRY=0"}) {
		t.Fatalf("Pi telemetry environment = %v", telemetry)
	}
	if os.Getenv("PI_TELEMETRY") != "1" {
		t.Fatal("Pi command changed the parent telemetry setting")
	}
}

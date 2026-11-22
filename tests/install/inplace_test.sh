#!/usr/bin/env bash
# Verifies install.sh's in-place self-update path: when PI_WEB_INPLACE_UPDATE is
# set, it must NOT stop/restart the service (doing so kills the npm process that
# spawned it — see internal/app/update.go), and must still swap the binary.
# Without the flag, the normal path must still stop the running instance.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Run install.sh in a sandboxed HOME with all external commands shimmed.
# $1: "inplace", "normal", "tampered", or "unexpected-member".
# $2: optional npm package version. When set, install.sh should download the
#     matching release tag instead of querying the latest release.
run_case() {
  local mode="$1"
  local package_version="${2:-}"
  local expected_tag="yugo-v9.9.9"
  [[ -n "$package_version" ]] && expected_tag="yugo-v${package_version#yugo-v}"
  local workdir bindir shimdir calllog
  workdir="$(mktemp -d)"
  bindir="$workdir/bin"
  shimdir="$workdir/shim"
  calllog="$workdir/calls.log"
  mkdir -p "$bindir" "$shimdir" "$workdir/fixture"

  printf '#!/bin/sh\necho %s\n' "$expected_tag" > "$workdir/fixture/pi-web"
  local notice
  for notice in LICENSE NOTICE THIRD_PARTY_NOTICES; do
    printf '%s\n' "$notice" > "$workdir/fixture/$notice"
  done
  local members=(pi-web LICENSE NOTICE THIRD_PARTY_NOTICES)
  if [[ "$mode" == "unexpected-member" ]]; then
    printf 'unexpected\n' > "$workdir/fixture/extra"
    members+=(extra)
  fi
  python3 - "$workdir" "$expected_tag" "${members[@]}" <<'PY'
from pathlib import Path
import hashlib, json, platform, sys, tarfile
directory = Path(sys.argv[1])
with tarfile.open(directory / 'asset.tar.gz', 'w:gz') as archive:
    for member in sys.argv[3:]:
        archive.add(directory / 'fixture' / member, arcname=member, recursive=False)
asset = (directory / 'asset.tar.gz').read_bytes()
architecture = 'amd64' if platform.machine() == 'x86_64' else 'arm64'
release = {'tag_name': sys.argv[2], 'draft': False, 'prerelease': True, 'assets': [
    {'name': f'yugo-pi-{platform.system().lower()}-{architecture}.tar.gz',
     'size': len(asset), 'digest': 'sha256:' + hashlib.sha256(asset).hexdigest(), 'state': 'uploaded'}
]}
(directory / 'release.json').write_text(json.dumps(release), encoding='utf-8')
PY
  if [[ "$mode" == "tampered" ]]; then
    printf '!' | dd of="$workdir/asset.tar.gz" bs=1 count=1 conv=notrunc 2>/dev/null
  fi

  # Serve the published release metadata and a local archive through the curl shim.
  cat > "$shimdir/curl" <<'SHIM'
#!/usr/bin/env bash
set -eu
for arg; do case "$arg" in https://*) url="$arg" ;; esac; done
case "$url" in
  *api.github.com*/releases/tags/"$EXPECTED_TAG") cat "$HOME/release.json" ;;
  *api.github.com*/releases\?*) printf '[ '; cat "$HOME/release.json"; printf ', {"tag_name":"yugo-v99.1.0","draft":true} ]' ;;
  *github.com*/releases/download/"$EXPECTED_TAG"/*) cat "$HOME/asset.tar.gz" ;;
  *raw.githubusercontent.com*/"$EXPECTED_TAG"/init/com.pi-web.plist) cat "$TEMPLATES/com.pi-web.plist" ;;
  *raw.githubusercontent.com*/"$EXPECTED_TAG"/init/pi-web.service) cat "$TEMPLATES/pi-web.service" ;;
  *) echo 'Unexpected release URL' >&2; exit 1 ;;
esac
SHIM

  # Service managers / pkill / sudo: log the call so we can assert on it.
  local tool
  for tool in systemctl launchctl pkill sudo; do
    cat > "$shimdir/$tool" <<SHIM
#!/usr/bin/env bash
echo "$tool \$*" >> "$calllog"
[[ "$tool" == "sudo" ]] && exec "\$@"
exit 0
SHIM
  done
  chmod +x "$shimdir"/*
  : > "$calllog"

  # A stale binary so the "stop running instance" path is reachable in normal mode.
  printf '#!/bin/sh\necho v0.0.0\n' > "$bindir/pi-web"
  chmod +x "$bindir/pi-web"

  local env_vars=(
    "HOME=$workdir"
    "PI_WEB_INSTALL_DIR=$bindir"
    "PATH=$shimdir:/usr/bin:/bin"
    "EXPECTED_TAG=$expected_tag"
    "TEMPLATES=$REPO_ROOT/init"
  )
  [[ "$mode" == "inplace" ]] && env_vars+=("PI_WEB_INPLACE_UPDATE=1")
  if [[ -n "$package_version" ]]; then
    env_vars+=("npm_package_name=@yinniora/yugo-pi" "npm_package_version=$package_version")
  fi

  local result=0
  env -i "${env_vars[@]}" bash "$INSTALL_SH" </dev/null > "$workdir/out.log" 2>&1 || result=$?
  if [[ "$mode" == "tampered" || "$mode" == "unexpected-member" ]]; then
    [[ "$result" -ne 0 ]] || fail "[$mode] malformed download was accepted"
    [[ "$("$bindir/pi-web")" == v0.0.0 && ! -s "$calllog" ]] || fail "[$mode] failed verification changed the running installation"
    echo "ok: $mode"
    rm -rf "$workdir"
    return
  fi
  [[ "$result" -eq 0 ]] || fail "[$mode] install.sh exited non-zero:"$'\n'"$(cat "$workdir/out.log")"

  [[ -x "$bindir/pi-web" ]] || fail "[$mode] binary missing after install"
  grep -q "$expected_tag" "$bindir/pi-web" \
    || fail "[$mode] binary not replaced with expected version $expected_tag"

  if [[ "$mode" == "inplace" ]]; then
    [[ ! -s "$calllog" ]] \
      || fail "[inplace] expected no service/pkill calls, got:"$'\n'"$(cat "$calllog")"
  else
    grep -Eq 'systemctl|launchctl|pkill' "$calllog" \
      || fail "[normal] expected the running instance to be stopped, but nothing was called"
    python3 - "$workdir" <<'PY'
import pathlib, plistlib, stat, sys
root = pathlib.Path(sys.argv[1])
env = root / '.config/pi-web/env'
token = dict(line.split('=', 1) for line in env.read_text().splitlines())['PI_WEB_TOKEN']
assert len(token) == 64 and token not in (root / 'out.log').read_text()
assert stat.S_IMODE(env.stat().st_mode) == 0o600
plist = root / 'Library/LaunchAgents/com.pi-web.plist'
if plist.exists():
    assert stat.S_IMODE(plist.stat().st_mode) == 0o600
    assert str(root / '.local/state/yugo-pi/logs') in plistlib.loads(plist.read_bytes())['StandardOutPath']
PY
  fi

  echo "ok: $mode"
  rm -rf "$workdir"
}

run_case inplace
run_case normal
run_case normal 1.2.3-beta.4
run_case tampered
run_case unexpected-member
echo "PASS: install.sh in-place self-update"

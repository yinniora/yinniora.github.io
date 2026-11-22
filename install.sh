#!/usr/bin/env bash
set -euo pipefail
umask 077

# pi-web installer — downloads the binary and sets up auto-start
#
# Standalone (no pi required):
#   curl -fsSL https://raw.githubusercontent.com/yinniora/yugo-pi/main/install.sh | bash
#
# Via pi package (also registers /remote, /refresh commands):
#   pi install npm:@yinniora/yugo-pi@beta
#
# Updates are handled by re-running the same command.

REPO="yinniora/yugo-pi"
if [[ -n "${PI_WEB_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$PI_WEB_INSTALL_DIR"
elif [[ -n "${npm_package_name:-}" ]]; then
  # pi installs npm packages non-interactively; avoid requiring sudo during npm postinstall.
  INSTALL_DIR="${HOME}/.pi/agent/bin"
else
  INSTALL_DIR="/usr/local/bin"
fi
BINARY="$INSTALL_DIR/pi-web"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="${HOME}/.pi/agent/pi-web-version"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}→${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}⚠${NC} $*" >&2; }
err()   { echo -e "${RED}✗${NC} $*" >&2; }

https_get() {
  local url="$1"
  if command -v curl &>/dev/null; then
    curl --proto '=https' --proto-redir '=https' --max-redirs 4 \
      --connect-timeout 15 --max-time 300 -fsSL "$url"
  elif command -v wget &>/dev/null; then
    wget --https-only --max-redirect=4 --timeout=30 --tries=2 -qO- "$url"
  else
    err "Neither curl nor wget found."
    return 1
  fi
}

# ── Detect platform ─────────────────────────────────────────────────
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)
      err "Unsupported OS: $(uname -s)"
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      err "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# ── Choose release tag ──────────────────────────────────────────────
package_tag() {
  # When install.sh runs as an npm lifecycle script, install the binary that
  # matches the npm package version. This keeps pinned installs such as
  # `pi install npm:@yinniora/yugo-pi@0.0.1-beta.25` pinned for both the extension
  # package and the downloaded pi-web binary.
  if [[ "${npm_package_name:-}" == "@yinniora/yugo-pi" && -n "${npm_package_version:-}" ]]; then
    echo "yugo-v${npm_package_version#yugo-v}"
  fi
}

# ── Check latest release tag ────────────────────────────────────────
latest_tag() {
  https_get "https://api.github.com/repos/${REPO}/releases?per_page=25" | python3 -c '
import json, re, sys
releases = json.load(sys.stdin)
candidates = []
for release in releases:
    tag = release.get("tag_name", "")
    version = re.fullmatch(r"yugo-v(\d{1,7})\.(\d{1,7})\.(\d{1,7})(?:-([A-Za-z]+)\.(\d{1,7}))?", tag)
    if release.get("draft") is False and version:
        major, minor, patch, suffix, revision = version.groups()
        candidates.append(((int(major), int(minor), int(patch), not suffix, suffix or "", int(revision or 0)), tag))
if not candidates:
    raise SystemExit("No published YuGo Pi release was found.")
print(max(candidates)[1])'
}

release_asset() {
  local tag="$1" asset="$2"
  https_get "https://api.github.com/repos/${REPO}/releases/tags/${tag}" | python3 -c '
import json, re, sys
release = json.load(sys.stdin)
tag, name = sys.argv[1:]
assets = [item for item in release["assets"] if item.get("name") == name]
if release.get("draft") is not False or release.get("tag_name") != tag or len(assets) != 1:
    raise SystemExit("This YuGo Pi release does not contain the expected archive.")
asset = assets[0]
size, digest = asset.get("size"), asset.get("digest")
if asset.get("state") != "uploaded" or type(size) is not int or not 0 < size <= 268435456 or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
    raise SystemExit("The YuGo Pi archive has no valid size or SHA-256 metadata.")
print(size, digest[7:])' "$tag" "$asset"
}

# ── Get installed version ───────────────────────────────────────────
installed_version() {
  if [[ -x "$BINARY" ]]; then
    "$BINARY" -version 2>/dev/null || true
  elif [[ -f "$VERSION_FILE" ]]; then
    # Binary not executable yet (e.g., partial install); fall back to version file
    cat "$VERSION_FILE"
  fi
}

# ── Check if update is needed ───────────────────────────────────────
needs_update() {
  local latest="$1"

  if [[ ! -f "$BINARY" ]]; then
    return 0  # not installed yet
  fi

  local installed
  installed="$(installed_version)"
  if [[ -n "$installed" ]] && [[ "${installed#yugo-v}" == "${latest#yugo-v}" ]]; then
    return 1  # already up-to-date
  fi

  if [[ -n "$installed" ]]; then
    info "Update available: ${installed} → ${latest}"
  else
    info "Existing binary found (unknown version). Installing ${latest}."
  fi

  return 0  # needs update
}

# ── Download binary ─────────────────────────────────────────────────
download_binary() {
  local platform="$1"
  local tag="$2"
  local asset="yugo-pi-${platform}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
  local metadata size digest
  metadata="$(release_asset "$tag" "$asset")" || return 1
  read -r size digest <<< "$metadata"

  info "Downloading pi-web ${tag} (${platform})..."
  info "  ${url}"

  local tmp
  tmp="$(mktemp -d)"
  trap "rm -rf -- $(printf '%q' "$tmp")" EXIT
  https_get "$url" | head -c "$((size + 1))" > "${tmp}/release.tar.gz" || return 1
  python3 - "$tmp" "$size" "$digest" <<'PY' || return 1
from pathlib import Path
import hashlib, hmac, shutil, sys, tarfile

root = Path(sys.argv[1])
archive = root / 'release.tar.gz'
digest = hashlib.sha256()
if archive.stat().st_size != int(sys.argv[2]):
    raise SystemExit('YuGo Pi download failed its size check.')
with archive.open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
if not hmac.compare_digest(digest.hexdigest(), sys.argv[3]):
    raise SystemExit('YuGo Pi download failed its SHA-256 check.')
files = {'pi-web': 256 * 1024 * 1024, 'LICENSE': 4 * 1024 * 1024,
         'NOTICE': 4 * 1024 * 1024, 'THIRD_PARTY_NOTICES': 8 * 1024 * 1024}
with tarfile.open(archive, 'r:gz') as package:
    for entry in package:
        if not entry.isfile() or not 0 < entry.size <= files.pop(entry.name, 0):
            raise SystemExit('Unexpected member in the YuGo Pi archive.')
        with package.extractfile(entry) as source, (root / entry.name).open('xb') as output:
            shutil.copyfileobj(source, output)
if files:
    raise SystemExit('The YuGo Pi archive is incomplete.')
PY
  local legal_dir="${HOME}/.local/share/yugo-pi/legal"
  mkdir -p "$legal_dir" || return 1
  cp "${tmp}/LICENSE" "${tmp}/NOTICE" "${tmp}/THIRD_PARTY_NOTICES" "$legal_dir/" || return 1
  chmod 755 "${tmp}/pi-web" || return 1
  trap - EXIT
  echo "${tmp}/pi-web"
}

# ── Install binary ──────────────────────────────────────────────────
install_binary() {
  local src="$1"
  local tag="$2"
  local is_update="${3:-false}"
  local inplace="${PI_WEB_INPLACE_UPDATE:-}"

  if [[ -f "$BINARY" ]] && [[ "$is_update" != "true" ]]; then
    # Interactive: ask before overwriting
    warn "pi-web already installed at ${BINARY}"
    read -rp "  Overwrite? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
      info "Skipping binary install."
      return 2
    fi
  fi

  # Stop running instance before replacing. Skipped for in-place self-updates:
  # pi-web spawned this script (via `pi install`), so stopping the service here
  # would kill the very npm process running it. pi-web triggers its own detached
  # restart afterward (see internal/app/update.go).
  if [[ -f "$BINARY" && -z "$inplace" ]]; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      systemctl --user stop pi-web.service 2>/dev/null || true
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      launchctl unload "${HOME}/Library/LaunchAgents/com.pi-web.plist" 2>/dev/null || true
    fi
    # Also try pkill for manually-started instances
    pkill -f "${BINARY}" 2>/dev/null || true
    sleep 1
  fi

  mkdir -p "$INSTALL_DIR" || return 1

  if [[ ! -w "$INSTALL_DIR" ]]; then
    info "Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo install -m 755 "$src" "$BINARY" || return 1
  elif [[ -n "$inplace" ]]; then
    # Atomic swap so the binary can be replaced while the old process still
    # runs — a plain cp over a running executable fails with ETXTBSY on Linux.
    # The temp file must share $BINARY's directory so the mv is a pure rename(2).
    local staged="${BINARY}.new.$$"
    install -m 755 "$src" "$staged" || return 1
    mv -f "$staged" "$BINARY" || return 1
  else
    install -m 755 "$src" "$BINARY" || return 1
  fi

  # Record version
  mkdir -p "$(dirname "$VERSION_FILE")" || return 1
  echo "$tag" > "$VERSION_FILE" || return 1

  info "pi-web ${tag} installed to ${BINARY}"
  return 0
}

# Copy the skill CLI next to the binary so `pi-web-ctl` works from any cwd.
# Missing source (standalone binary-only install) is a no-op — skills ship
# with the npm package, not the GitHub release tarball.
install_ctl() {
  local src="${SRC_DIR}/.pi/skills/common/pi_web.py"
  if [[ "${npm_package_name:-}" != "@yinniora/yugo-pi" || ! -f "$src" ]]; then
    return 0
  fi
  mkdir -p "$INSTALL_DIR"
  local dest="${INSTALL_DIR}/pi-web-ctl"
  if [[ ! -w "$INSTALL_DIR" ]]; then
    sudo install -m 755 "$src" "$dest"
  else
    install -m 755 "$src" "$dest"
  fi
  info "pi-web-ctl installed to ${dest}"
}

# ── Fetch config file from repo (for standalone installs) ──────────
fetch_config() {
  local file="$1"
  local dest="$2"
  local tag="$3"
  https_get "https://raw.githubusercontent.com/${REPO}/${tag}/${file}" > "$dest"
}

# ── macOS auto-start ─────────────────────────────────────────────────
setup_macos() {
  local tag="$1"
  local plist_dst="${HOME}/Library/LaunchAgents/com.pi-web.plist"
  local needs_reload=true

  mkdir -p "${HOME}/Library/LaunchAgents"

  if [[ -L "$plist_dst" ]]; then
    err "The launch agent path must be a regular file."
    return 1
  fi
  local generated raw=""
  generated="$(mktemp "${plist_dst}.XXXXXX")"
  local plist_src="${SRC_DIR}/init/com.pi-web.plist"
  if [[ "${npm_package_name:-}" != "@yinniora/yugo-pi" || ! -f "$plist_src" ]]; then
    info "Fetching launchd config from repo..."
    raw="$(mktemp)"
    fetch_config "init/com.pi-web.plist" "$raw" "$tag"
    plist_src="$raw"
  fi

  info "pi-web will listen on localhost; if Tailscale is running, it will publish HTTPS with Tailscale Serve."

  # Pass the generated environment to launchd. This includes PI_WEB_TOKEN and
  # PATH so pi-web can find `pi` when serving browser chat requests.
  local env_file="${HOME}/.config/pi-web/env"
  local logs="${HOME}/.local/state/yugo-pi/logs"
  mkdir -p "$logs"
  chmod 700 "$logs"
  python3 - "$plist_src" "$generated" "$BINARY" "$env_file" "$logs" <<'PY'
from pathlib import Path
import plistlib, sys

src, output, binary, config, logs = sys.argv[1:]
job = plistlib.loads(Path(src).read_bytes())
job['ProgramArguments'][0] = binary
job['EnvironmentVariables'] = {
    key: value for key, _, value in (line.partition('=') for line in Path(config).read_text(encoding='utf-8').splitlines())
    if key in {'PI_WEB_TOKEN', 'PI_CODING_AGENT_DIR', 'PATH'}
}
job['StandardOutPath'] = str(Path(logs) / 'stdout.log')
job['StandardErrorPath'] = str(Path(logs) / 'stderr.log')
with Path(output).open('wb') as stream:
    plistlib.dump(job, stream)
PY
  if [[ -n "$raw" ]]; then rm -f "$raw"; fi

  # Check if plist changed
  if [[ -f "$plist_dst" ]]; then
    chmod 600 "$plist_dst"
    if cmp -s "$generated" "$plist_dst"; then
      info "Auto-start config unchanged."
      needs_reload=false
    fi
  fi

  if [[ "$needs_reload" == "true" ]]; then
    mv -f "$generated" "$plist_dst"
    launchctl bootout "gui/$(id -u)" "$plist_dst" 2>/dev/null || launchctl unload "$plist_dst" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist_dst" 2>/dev/null || launchctl load "$plist_dst"
    info "macOS auto-start configured (launchd)"
  fi

  rm -f "$generated"

  # Restart if already running
  launchctl kickstart -k "gui/$(id -u)/com.pi-web" 2>/dev/null || {
    launchctl stop com.pi-web 2>/dev/null || true
    launchctl start com.pi-web 2>/dev/null || true
  }
}

# ── Linux auto-start (systemd user service) ──────────────────────────
setup_linux() {
  local tag="$1"
  local service_dir="${HOME}/.config/systemd/user"
  local service_dst="${service_dir}/pi-web.service"
  local needs_reload=true

  mkdir -p "$service_dir"

  # Get service file from local clone or fetch from repo
  local service_src="${SRC_DIR}/init/pi-web.service"
  if [[ "${npm_package_name:-}" != "@yinniora/yugo-pi" || ! -f "$service_src" ]]; then
    info "Fetching systemd service file from repo..."
    service_src="$(mktemp)"
    fetch_config "init/pi-web.service" "$service_src" "$tag"
  fi

  local generated_service
  generated_service="$(mktemp)"
  sed "s|/usr/local/bin/pi-web|${BINARY}|g" "$service_src" > "$generated_service"
  info "pi-web will listen on localhost; if Tailscale is running, it will publish HTTPS with Tailscale Serve."

  # Check if service file changed
  if [[ -f "$service_dst" ]]; then
    if cmp -s "$generated_service" "$service_dst"; then
      info "Service config unchanged."
      needs_reload=false
    fi
  fi

  if [[ "$needs_reload" == "true" ]]; then
    cp "$generated_service" "$service_dst"
    systemctl --user daemon-reload 2>/dev/null || {
      warn "Could not reload user systemd; skipping auto-start setup."
      return 0
    }
    info "Linux auto-start updated (systemd user service)"
  fi

  # Enable and restart when user systemd is available.
  systemctl --user enable pi-web.service 2>/dev/null || true
  systemctl --user restart pi-web.service 2>/dev/null || {
    # Service may not be running yet (first install)
    systemctl --user start pi-web.service 2>/dev/null || true
  }
}

# ── Environment setup ────────────────────────────────────────────────
set_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    err "A value in the local service environment contains a line break."
    return 1
  fi
  local next line found=false
  next="$(mktemp "${file}.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      if [[ "$found" == "false" ]]; then printf '%s=%s\n' "$key" "$value"; fi
      found=true
    else
      printf '%s\n' "$line"
    fi
  done < "$file" > "$next"
  if [[ "$found" == "false" ]]; then printf '%s=%s\n' "$key" "$value" >> "$next"; fi
  mv -f "$next" "$file"
}

setup_env() {
  local env_dir="${HOME}/.config/pi-web"
  local env_file="${env_dir}/env"

  if [[ -L "$env_dir" || -L "$env_file" ]]; then
    err "The local service environment must use private files."
    return 1
  fi
  mkdir -p "$env_dir"
  chmod 700 "$env_dir"
  touch "$env_file"
  chmod 600 "$env_file"

  if ! grep -q '^PI_WEB_TOKEN=' "$env_file"; then
    local token="${PI_WEB_TOKEN:-}"
    if [[ -z "$token" ]]; then token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"; fi
    set_env_var "$env_file" "PI_WEB_TOKEN" "$token"
    info "Saved the local service token in ${env_file}"
  fi

  # Persist PI_CODING_AGENT_DIR so auto-started pi-web finds the right sessions.
  if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
    set_env_var "$env_file" "PI_CODING_AGENT_DIR" "${PI_CODING_AGENT_DIR}"
  fi

  # Services launched by systemd/launchd often have a minimal PATH. Preserve the
  # install-time PATH so pi-web can find `pi` for browser chat (`pi --mode rpc`).
  set_env_var "$env_file" "PATH" "${PATH}"
}

# ── Main ────────────────────────────────────────────────────────────
main() {
  echo ""
  info "pi-web installer"
  if ! command -v python3 &>/dev/null; then
    err "This installer requires Python 3 to verify published release metadata and archives."
    exit 1
  fi
  echo ""

  local platform
  platform="$(detect_platform)"

  local tag
  tag="$(package_tag)"
  if [[ -n "$tag" ]]; then
    info "Using pi-web package version ${tag}."
  else
    tag="$(latest_tag)"
  fi
  if [[ ! "$tag" =~ ^yugo-v[0-9]{1,7}\.[0-9]{1,7}\.[0-9]{1,7}(-[A-Za-z]+\.[0-9]{1,7})?$ ]]; then
    err "Unexpected YuGo Pi release tag."
    exit 1
  fi

  if ! needs_update "$tag"; then
    install_ctl
    info "Already up-to-date (${tag})."
    echo ""
    exit 0
  fi

  local tmp_binary
  tmp_binary="$(download_binary "$platform" "$tag")"
  trap "rm -rf -- $(printf '%q' "$(dirname "$tmp_binary")")" EXIT

  # Check if running interactively
  local is_update=false
  if [[ ! -t 0 ]]; then
    is_update=true  # non-interactive → update mode (no prompts)
  fi

  local status=0
  install_binary "$tmp_binary" "$tag" "$is_update" || status=$?
  if [[ "$status" -eq 2 ]]; then exit 0; fi
  if [[ "$status" -ne 0 ]]; then exit "$status"; fi

  # In-place self-update: pi-web triggered this and restarts itself afterward
  # via its own /api/restart. Skip env/service setup so we don't restart (and
  # kill) the npm process running this script, or clobber the service's PATH.
  if [[ -n "${PI_WEB_INPLACE_UPDATE:-}" ]]; then
    install_ctl
    info "Binary updated to ${tag}; pi-web will restart to apply it."
    echo ""
    exit 0
  fi

  install_ctl
  setup_env

  case "$(uname -s)" in
    Darwin) setup_macos "$tag" ;;
    Linux)  setup_linux "$tag" ;;
  esac

  info "Done! pi-web ${tag} is ready."
  echo ""
}

main

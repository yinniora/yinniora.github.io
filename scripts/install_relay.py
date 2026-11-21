#!/usr/bin/env python3
"""Install or update one private YuGo Pi relay on a Debian or Ubuntu VPS."""
import argparse
import base64
import fcntl
import hashlib
import hmac
import io
import ipaddress
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit


RELEASE_TAG = '@YUGO_RELEASE_TAG@'
CADDY_VERSION = '2.11.9'
CADDY_DIGESTS = {
    'amd64': '5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb',
    'arm64': '5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165',
}
TAG_PATTERN = re.compile(r'yugo-v([0-9]+)\.([0-9]+)\.([0-9]+)-yugo\.([0-9]+)')
STATE = Path('/var/lib/yugo-pi-relay')
CONF = Path('/etc/yugo-pi-relay')
BIN = Path('/usr/local/libexec/yugo-pi-relay')
UNITS = Path('/etc/systemd/system')
RUNTIME = Path('/run/yugo-pi-relay-setup')
SYSTEM_LOCK = Path('/run/lock/yugo-pi-relay.lock')
INSTALLED_TOOL = Path('/usr/local/bin/yugo-pi-relay-setup')
DEFAULT_CLIENT = 'https://yinniora.github.io/'
BROKER = 'yugo-pi-relay.service'
TURN = 'yugo-pi-turn.service'
HTTPS = 'yugo-pi-relay-https.service'
SERVICES = (BROKER, TURN, HTTPS)


def run(*arguments, check=True, **kwargs):
    return subprocess.run(arguments, check=check, **kwargs)


def online(unit):
    return run('systemctl', 'is-active', '--quiet', unit, check=False).returncode == 0


def public_origin(raw):
    value = raw.strip()
    if re.search(r'[\s\x00-\x1f\x7f]', value):
        raise ValueError('Invalid public HTTPS hostname.')
    if '://' not in value:
        try:
            value = '[' + str(ipaddress.IPv6Address(value)) + ']'
        except ValueError:
            pass
    url = urlsplit(value if '://' in value else 'https://' + value)
    if (url.scheme != 'https' or not url.hostname or url.username is not None or
            url.password is not None or url.path not in ('', '/') or url.query or url.fragment or
            url.port not in (None, 443)):
        raise ValueError('Use a public IP or HTTPS hostname on port 443.')
    host = url.hostname.lower()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if (len(host) > 253 or '.' not in host or host.endswith(('.local', '.localhost')) or
                not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', s) for s in host.split('.'))):
            raise ValueError('Invalid public HTTPS hostname.') from None
        return 'https://' + host
    if not address.is_global or address.is_multicast:
        raise ValueError('Automatic HTTPS requires a public IP address.')
    return 'https://' + (f'[{address}]' if address.version == 6 else str(address))


def turn_mapping(value):
    if not value:
        return ''
    public, sep, local = value.partition('/')
    public = ipaddress.ip_address(public)
    if not public.is_global or public.is_multicast:
        raise ValueError('TURN external IP must be a public unicast address.')
    if not sep:
        return str(public)
    local = ipaddress.ip_address(local)
    if local.version != public.version or local.is_unspecified or local.is_multicast or local.is_loopback:
        raise ValueError('TURN external IP mapping requires a local interface address of the same family.')
    return f'{public}/{local}'


def get_bytes(url, limit):
    with urllib.request.urlopen(url, timeout=45) as response:
        if urlsplit(response.geturl()).scheme != 'https':
            raise ValueError('Download redirected to an insecure URL.')
        body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Download exceeds its size limit.')
    return body


def verified_archive(url, expected):
    if not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('The release asset has no SHA-256 digest.')
    content = get_bytes(url, 64 * 1024 * 1024)
    if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), expected):
        raise ValueError('Release archive failed SHA-256 verification.')
    return tarfile.open(fileobj=io.BytesIO(content), mode='r:gz')


def archive_file(archive, name, maximum):
    entry = archive.getmember(name)
    if not entry.isfile() or not 0 < entry.size <= maximum:
        raise ValueError('Invalid release archive member: ' + name)
    with archive.extractfile(entry) as source:
        return source.read()


def release_archive(tag, arch):
    name = f'yugo-pi-relay-linux-{arch}.tar.gz'
    api = 'https://api.github.com/repos/yinniora/yugo-pi/releases/tags/' + tag
    data = json.loads(get_bytes(api, 1024 * 1024))
    asset = next((a for a in data['assets'] if a['name'] == name), None)
    if asset is None:
        raise ValueError('This release has no Linux relay archive for ' + arch)
    url = f'https://github.com/yinniora/yugo-pi/releases/download/{tag}/{name}'
    return verified_archive(url, (asset.get('digest') or '').removeprefix('sha256:'))


def release_order(tag):
    match = TAG_PATTERN.fullmatch(tag)
    return tuple(map(int, match.groups())) if match else ()


def check_update(installed, arch):
    if not release_order(installed):
        raise ValueError('No managed YuGo Pi relay installation was found.')
    releases = json.loads(get_bytes('https://api.github.com/repos/yinniora/yugo-pi/releases?per_page=25', 4 * 1024 * 1024))
    name = f'yugo-pi-relay-linux-{arch}.tar.gz'
    candidates = [release['tag_name'] for release in releases
                  if not release['draft'] and release_order(release['tag_name']) and
                  any(asset['name'] == name for asset in release['assets'])]
    latest = max(candidates, key=release_order, default=installed)
    print('Installed relay:', installed)
    if release_order(latest) <= release_order(installed):
        print('No newer YuGo Pi relay release was found.')
    else:
        print(f'Update available. Run sudo yugo-pi-relay-setup --version {latest}')


def caddy_archive(arch):
    name = f'caddy_{CADDY_VERSION}_linux_{arch}.tar.gz'
    return verified_archive(f'https://github.com/caddyserver/caddy/releases/download/v{CADDY_VERSION}/{name}', CADDY_DIGESTS[arch])


def write_file(path, content, mode=0o600, owner=None):
    if path.is_file() and not path.is_symlink() and path.read_bytes() == content and (path.stat().st_mode & 0o777) == mode:
        return False
    with tempfile.NamedTemporaryFile(prefix='.' + path.name + '-', dir=path.parent, delete=False) as temporary:
        staged = Path(temporary.name)
        try:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            os.fchmod(temporary.fileno(), mode)
            if owner:
                os.fchown(temporary.fileno(), *owner)
            staged.replace(path)
        finally:
            staged.unlink(missing_ok=True)
    return True


def read_profile():
    profile_file = STATE / 'private/connection.json'
    if not profile_file.exists():
        return None
    folder = profile_file.parent
    if folder.is_symlink() or folder.stat().st_uid != os.geteuid() or folder.stat().st_mode & 0o077:
        raise ValueError('The relay credential directory must be private.')
    for name in ('connection.json', 'relay.env', 'turnserver.conf'):
        path = profile_file.with_name(name)
        info = path.stat()
        if path.is_symlink() or not path.is_file() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('Relay credentials must be root-only regular files.')
    return json.loads(profile_file.read_text())


def caddyfile(origin):
    host = urlsplit(origin).hostname
    global_tls = ''
    extra = ''
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        global_tls = f'\n\tdefault_sni {host}'
        extra = '\n\ttls {\n\t\tissuer acme https://acme-v02.api.letsencrypt.org/directory {\n\t\t\tprofile shortlived\n\t\t}\n\t}\n'
    return (f'''{{
	admin off{global_tls}
	servers {{
		protocols h1 h2
	}}
}}
{origin} {{{extra}
	@relay path /signal /ice /verify /setup
	handle @relay {{
		reverse_proxy 127.0.0.1:43120 {{
			header_up X-Forwarded-For {{remote_host}}
		}}
	}}
	handle {{
		respond 404
	}}
}}
''').encode()


def unit(description, service):
    return (f'''[Unit]
Description={description}
After=network-online.target
Wants=network-online.target

[Service]
{service}
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
''').encode()


def active_ports():
    output = run('ss', '-Hltun', capture_output=True, text=True).stdout
    return {int(match.group(1)) for line in output.splitlines() if len(line.split()) >= 5
            if (match := re.search(r':([0-9]+)$', line.split()[4]))}


def preflight(external_proxy):
    ports = active_ports()
    services = [(BROKER, {43120}), (TURN, {3478} | set(range(49160, 49221)))]
    if not external_proxy:
        services.append((HTTPS, {80, 443}))
    for service, used in services:
        conflict = ports & used
        if conflict and not online(service):
            found = ', '.join(map(str, sorted(conflict)))
            raise ValueError(f'Ports {found} are in use. Keep existing services and use a dedicated VPS or an existing HTTPS proxy.')


def install_coturn():
    if shutil.which('turnserver'):
        return
    # The separate service below supplies the authenticated-only settings.
    run('systemctl', 'mask', 'coturn.service')
    env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}
    run('apt-get', 'update', env=env)
    run('apt-get', 'install', '-y', '--no-install-recommends', 'coturn', 'ca-certificates', env=env)


def verify_relay(profile, client):
    challenge = secrets.token_hex(32)
    query = urlencode({'room': profile['room'], 'challenge': challenge})
    req = urllib.request.Request(profile['serverUrl'] + '/verify?' + query,
                                 headers={'Authorization': 'Bearer ' + profile['hostToken']})
    # /verify must not redirect to a different service while carrying a token.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None

    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=4) as result:
            public = json.loads(result.read(8192))
    except (OSError, ValueError):
        return False
    if not isinstance(public, dict):
        return False
    for key, expected in (('protocol', 'pi-relay-v2'), ('clientOrigin', client),
                          ('turnHost', urlsplit(profile['serverUrl']).hostname), ('requiresClientAuth', True)):
        if public.get(key) != expected:
            return False
    for key, secret, kind in (('proof', 'turnSecret', 'turn'), ('clientProof', 'clientSecret', 'client')):
        expected = hmac.new(profile[secret].encode(), f'pi-relay-config-v1:{kind}:{challenge}'.encode(), 'sha256').hexdigest()
        if not isinstance(public.get(key), str) or not hmac.compare_digest(public[key], expected):
            return False
    return True


def print_code(profile):
    owner = RUNTIME.stat()
    if owner.st_mode & 0o077:
        raise ValueError('The relay setup directory must be private.')
    now = int(time.time())
    for path in RUNTIME.iterdir():
        if re.fullmatch(r'[a-f0-9]{64}', path.name):
            # Only the most recent setup code remains valid.
            path.unlink(missing_ok=True)
    token = secrets.token_hex(32)
    target = RUNTIME / hashlib.sha256(token.encode()).hexdigest()
    write_file(target, f'{now + 15 * 60}\n'.encode(), owner=(owner.st_uid, owner.st_gid))
    payload = json.dumps({'serverUrl': profile['serverUrl'], 'token': token}, separators=(',', ':')).encode()
    print('Paste this one-time code into YuGo Pi on the computer you want to connect. It expires in 15 minutes.', flush=True)
    print('yugopi-relay:' + base64.urlsafe_b64encode(payload).rstrip(b'=').decode(), flush=True)


def setup(options, tag, arch, existing, origin, client, external_ip):
    saved_settings = STATE / 'installation.json'
    saved = json.loads(saved_settings.read_text()) if saved_settings.is_file() else {}
    if existing and existing['serverUrl'] != origin:
        raise ValueError('This installation already belongs to another relay address. Keep its current origin to upgrade.')
    if 'client' in saved and saved['client'] != client:
        raise ValueError('This installation already uses a different trusted client origin.')
    if 'externalProxy' in saved and saved['externalProxy'] != options.external_proxy:
        raise ValueError('Keep the existing HTTPS proxy mode when upgrading.')
    external_ip = external_ip or saved.get('externalIP', '')
    preflight(options.external_proxy)
    for folder in (STATE, CONF, BIN):
        folder.mkdir(mode=0o700 if folder != BIN else 0o755, parents=True, exist_ok=True)
        if folder.is_symlink() or folder.stat().st_uid != os.geteuid() or folder.stat().st_mode & 0o022:
            raise ValueError('An installer directory has unsafe ownership or permissions.')
    services = SERVICES[:-1] if options.external_proxy else SERVICES
    running = {service for service in services if online(service)}
    with release_archive(tag, arch) as asset, tempfile.TemporaryDirectory(dir=STATE) as staging_dir:
        staging = Path(staging_dir)
        relay = archive_file(asset, 'pi-relay', 48 * 1024 * 1024)
        installer = archive_file(asset, 'yugo-pi-relay-install.py', 128 * 1024)
        legal = {name: archive_file(asset, name, 2 * 1024 * 1024)
                 for name in ('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES')}
        if existing is None:
            generator = staging / 'generate_relay_config.py'
            generator.write_bytes(archive_file(asset, generator.name, 128 * 1024))
            credentials = staging / 'private'
            run('python3', str(generator), '--server', origin, '--client', client, '--out', str(credentials),
                stdout=subprocess.DEVNULL)
            credentials.rename(STATE / 'private')
    profile = read_profile()
    recorded_origin = f'PI_RELAY_CLIENT_ORIGIN={client}'
    if recorded_origin not in (STATE / 'private/relay.env').read_text().splitlines():
        raise ValueError('The relay already has credentials for a different trusted client origin.')
    previous = {}

    def update(path, content, mode=0o600):
        if path.exists():
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid():
                raise ValueError('Refusing to replace a file not owned by this installer: ' + str(path))
            old = (path.read_bytes(), path.stat().st_mode & 0o777)
        else:
            old = None
        modified = write_file(path, content, mode)
        if modified:
            previous[path] = old
        return modified

    try:
        install_coturn()
        broker_changed = update(BIN / 'pi-relay', relay, 0o755)
        broker_changed |= update(UNITS / BROKER, unit('YuGo Pi authenticated relay', f'''ExecStart={BIN}/pi-relay
EnvironmentFile={STATE}/private/relay.env
Environment=PI_RELAY_SERVER_URL={origin}
Environment=PI_RELAY_SETUP_DIR={RUNTIME}
RuntimeDirectory={RUNTIME.name}
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=restart'''), 0o644)
        turn_base = (STATE / 'private/turnserver.conf').read_text()
        if external_ip:
            turn_base += 'external-ip=' + external_ip + '\n'
        turn_changed = update(CONF / 'turnserver.conf', turn_base.encode())
        turn_changed |= update(UNITS / TURN, unit('YuGo Pi authenticated TURN relay', f'''LoadCredential=turnserver.conf:{CONF}/turnserver.conf
RuntimeDirectory=yugo-pi-turn
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/turnserver -c ${{CREDENTIALS_DIRECTORY}}/turnserver.conf --no-tls --no-dtls --no-tcp-relay --pidfile=/run/yugo-pi-turn/turn.pid --log-file=stdout'''), 0o644)
        https_changed = False
        if not options.external_proxy:
            caddy_version = CONF / 'caddy-version'
            if not (BIN / 'caddy').is_file() or not caddy_version.is_file() or caddy_version.read_text().strip() != CADDY_VERSION:
                with caddy_archive(arch) as archive:
                    https_changed = update(BIN / 'caddy', archive_file(archive, 'caddy', 48 * 1024 * 1024), 0o755)
                update(caddy_version, (CADDY_VERSION + '\n').encode())
            https_changed |= update(CONF / 'Caddyfile', caddyfile(origin))
            https_changed |= update(UNITS / HTTPS, unit('YuGo Pi relay HTTPS gateway', f'''LoadCredential=Caddyfile:{CONF}/Caddyfile
ExecStart={BIN}/caddy run --adapter caddyfile --config ${{CREDENTIALS_DIRECTORY}}/Caddyfile
StateDirectory=yugo-pi-relay-https
StateDirectoryMode=0700
Environment=XDG_DATA_HOME=/var/lib/yugo-pi-relay-https
Environment=XDG_CONFIG_HOME=/var/lib/yugo-pi-relay-https
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE'''), 0o644)
        else:
            update(CONF / 'Caddyfile.example', caddyfile(origin))
        for name, content in legal.items():
            update(BIN / name, content, 0o644)
        update(INSTALLED_TOOL, installer, 0o755)
        run('systemctl', 'daemon-reload')
        changed = {BROKER: broker_changed, TURN: turn_changed, HTTPS: https_changed}
        for service in services:
            run('systemctl', 'restart' if changed[service] and service in running else 'start', service)
        print('Checking the public HTTPS relay. The server firewall must allow TCP 80/443, TCP/UDP 3478, and UDP 49160–49220.', flush=True)
        deadline = time.monotonic() + (8 if options.external_proxy else 90)
        while not verify_relay(profile, client):
            if time.monotonic() >= deadline:
                raise ValueError('Public HTTPS or relay authentication is unavailable. Check DNS, certificates and firewall. For an existing proxy, forward /signal (WebSocket), /ice, /verify and /setup.')
            time.sleep(2)
        if not all(online(service) for service in services) or 3478 not in active_ports():
            raise ValueError('Relay services started, but the TURN listening port is unavailable.')
        update(saved_settings, json.dumps({'client': client, 'externalProxy': options.external_proxy,
                                           'externalIP': external_ip, 'tag': tag}).encode())
        run('systemctl', 'enable', *services)
    except (OSError, ValueError, subprocess.CalledProcessError):
        for service in services:
            if service not in running and online(service):
                run('systemctl', 'stop', service, check=False)
        for path, old in reversed(previous.items()):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                write_file(path, *old)
        run('systemctl', 'daemon-reload', check=False)
        for service in services:
            if service in running:
                run('systemctl', 'restart', service, check=False)
        raise
    print('Private file fallback:', STATE / 'private/connection.json', flush=True)
    print_code(profile)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', help='Public HTTPS domain or IP address')
    parser.add_argument('--client', help='Trusted, separately hosted HTTPS phone client')
    parser.add_argument('--version', help='YuGo release tag. The downloaded script defaults to its matching tag.')
    parser.add_argument('--external-proxy', action=argparse.BooleanOptionalAction, default=None,
                        help='Use an existing HTTPS proxy instead of installing the supplied HTTPS gateway.')
    parser.add_argument('--external-ip', help='Optional TURN public IP or PUBLIC/PRIVATE IP mapping for a VPS behind NAT')
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument('--new-code', action='store_true', help='Print a fresh setup code without updating the relay.')
    operation.add_argument('--check-update', action='store_true', help='Check for an update without installing it.')
    options = parser.parse_args()
    if os.geteuid() != 0 or platform.system() != 'Linux':
        parser.error('Run on the relay VPS as root, for example using sudo.')
    if not os.path.isfile('/etc/os-release'):
        parser.error('This installer supports Debian and Ubuntu with systemd.')
    distro = platform.freedesktop_os_release()
    minimum = {'debian': 12, 'ubuntu': 22}.get(distro['ID'])
    version = int(distro.get('VERSION_ID', '0').split('.')[0])
    if minimum is None or version < minimum or not shutil.which('systemctl') or not shutil.which('ss'):
        parser.error('This installer supports Debian 12+ and Ubuntu 22.04+ with systemd and iproute2.')
    tag = options.version or RELEASE_TAG
    if not (options.new_code or options.check_update) and not release_order(tag):
        parser.error('Use the versioned installer from YuGo Releases, or supply --version yugo-vX.Y.Z-yugo.N.')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if arch is None:
        parser.error('This installer supports amd64 and arm64.')
    os.umask(0o077)
    with SYSTEM_LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            existing = read_profile()
            saved_settings = STATE / 'installation.json'
            saved = json.loads(saved_settings.read_text()) if saved_settings.is_file() else {}
            if options.check_update:
                check_update(saved.get('tag', ''), arch)
                return
            if options.new_code:
                if existing is None or not online(BROKER) or not verify_relay(existing, saved.get('client', DEFAULT_CLIENT.rstrip('/'))):
                    raise ValueError('Complete installation and its HTTPS check before issuing a setup code.')
                print_code(existing)
                return
            if release_order(tag) < release_order(saved.get('tag', '')):
                raise ValueError('A newer relay version is already installed.')
            if options.external_proxy is None:
                options.external_proxy = saved.get('externalProxy', False)
            server = options.server or (existing and existing['serverUrl'])
            origin = public_origin(server or input('Public VPS IP or domain: '))
            client = public_origin(options.client or saved.get('client', DEFAULT_CLIENT))
            if client == origin:
                raise ValueError('The phone client must have its own HTTPS origin.')
            setup(options, tag, arch, existing, origin, client, turn_mapping(options.external_ip))
        except (EOFError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            parser.exit(1, f'Install relay: {error}\n')


if __name__ == '__main__':
    main()

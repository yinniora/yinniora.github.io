#!/usr/bin/env python3
"""Generate private server settings for a separately hosted Pi relay."""
import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', required=True, help='Public HTTPS origin, for example https://relay.example.com')
parser.add_argument('--client', default='https://yinniora.github.io/', help='Independently hosted Pi client URL; never a page served by the relay')
parser.add_argument('--out', type=Path, default=Path('relay-private'))
args = parser.parse_args()
server, client = urlparse(args.server), urlparse(args.client)
if any(u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment for u in (server, client)) or server.path not in ('', '/'):
    parser.error('Use HTTPS origins without credentials, query or fragment')
if server.netloc == client.netloc:
    parser.error('Host the trusted client on a separate origin from the untrusted relay')
if args.out.exists():
    parser.error('Output already exists; refusing to replace existing relay credentials')
args.out.mkdir(mode=0o700, parents=True)
room, host, turn, enrollment = (secrets.token_hex(32) for _ in range(4))
profile = dict(serverUrl=args.server.rstrip('/'), room=room, hostToken=host, turnSecret=turn, clientSecret=enrollment)
origin = client.scheme + '://' + client.netloc
# Plain hexadecimal secrets need no shell escaping. This file is a systemd EnvironmentFile.
env = dict(PI_RELAY_ROOM=room, PI_RELAY_HOST_TOKEN=host, PI_RELAY_TURN_SECRET=turn,
           PI_RELAY_CLIENT_SECRET=enrollment, PI_RELAY_PUBLIC_IP=server.hostname, PI_RELAY_CLIENT_ORIGIN=origin)
files = {
    '.gitignore': '*\n',
    'relay.env': ''.join(key + '=' + value + '\n' for key, value in env.items()),
    'connection.json': json.dumps(profile, indent=2) + '\n',
    'turnserver.conf': '\n'.join([
        'listening-port=3478', 'fingerprint', 'use-auth-secret', 'static-auth-secret=' + turn,
        'realm=pi-relay', 'min-port=49160', 'max-port=49220', 'user-quota=4', 'total-quota=32',
        'max-bps=1000000', 'bps-capacity=12000000', 'no-cli', 'no-multicast-peers',
        'denied-peer-ip=0.0.0.0-0.255.255.255', 'denied-peer-ip=10.0.0.0-10.255.255.255',
        'denied-peer-ip=100.64.0.0-100.127.255.255', 'denied-peer-ip=127.0.0.0-127.255.255.255',
        'denied-peer-ip=169.254.0.0-169.254.255.255', 'denied-peer-ip=172.16.0.0-172.31.255.255',
        'denied-peer-ip=192.168.0.0-192.168.255.255', 'denied-peer-ip=224.0.0.0-255.255.255.255',
        'denied-peer-ip=::1', 'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        '# If the relay host is behind NAT, set external-ip to its public/private mapping.', '']),
}
for name, text in files.items():
    with (args.out / name).open('x') as stream:
        os.chmod(stream.name, 0o600)
        stream.write(text)
print('Created private relay.env, turnserver.conf and connection.json in', args.out)
print('Import connection.json only in Pi on the Mac. Do not commit or publish this directory.')

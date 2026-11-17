#!/usr/bin/env python3
"""Install a fresh Mac Pi window with local approval and no public HTTP listener."""
from pathlib import Path
import argparse
import os
import plistlib
import secrets
import shutil
import subprocess
import sys
from urllib.parse import urlparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--client', default='https://yinniora.github.io/', help='Independent trusted HTTPS Pi client')
parser.add_argument('--start', action='store_true', help='Start the installed launch agent now')
args = parser.parse_args()
if sys.platform != 'darwin':
    parser.error('Run this installer on the Mac that Pi will control')
client = urlparse(args.client)
if client.scheme != 'https' or not client.hostname or client.username or client.password or client.query or client.fragment:
    parser.error('Use an HTTPS client URL without credentials or pairing data')
source = Path(__file__).resolve().parent.parent
mac_home = Path.home()
plist = mac_home / 'Library/LaunchAgents/com.pi-web.plist'
apps = ['Pi Chat', 'Pi Device Approval']
if plist.exists() or any((mac_home / 'Applications' / (name + '.app')).exists() for name in apps):
    parser.error('An installation already exists; this fresh installer will not overwrite its keys or apps')
if not (source / 'pi-web').is_file() or any(not (source / 'build/macos.noindex' / (name + '.app')).is_dir() for name in apps):
    parser.error('First run make build and python3 scripts/build_macos.py')
if not shutil.which('pi'):
    parser.error('Install Pi CLI and configure your model service first')
agent = mac_home / '.pi/agent'
(agent / 'sessions').mkdir(parents=True, exist_ok=True)
runtime = mac_home / '.local/share/pi-hub'
runtime.mkdir(parents=True, exist_ok=True)
(mac_home / 'Applications').mkdir(exist_ok=True)
for name in apps:
    destination = mac_home / 'Applications' / (name + '.app')
    shutil.copytree(source / 'build/macos.noindex' / (name + '.app'), destination)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(destination)], check=True)
shutil.copy2(source / 'pi-web', runtime / 'pi-web')
(runtime / 'pi-web').chmod(0o755)
logs = agent / 'remote/logs'
logs.mkdir(parents=True, exist_ok=True, mode=0o700)
for name in ['stdout.log', 'stderr.log']:
    (logs / name).touch(mode=0o600)
workspace = mac_home / 'Pi Projects'
workspace.mkdir(exist_ok=True)
env = dict(PATH=os.environ.get('PATH', '/usr/bin:/bin'), PI_WEB_TOKEN=secrets.token_hex(32),
           PI_WEB_DEVICE_AUTH='1', PI_WEB_REMOTE_CLIENT_URL=args.client,
           PI_WEB_PAIR_APPROVER=str(mac_home / 'Applications/Pi Device Approval.app/Contents/MacOS/Pi Device Approval'),
           PI_WEB_PROJECT_TRASH_HELPER=str(mac_home / 'Applications/Pi Chat.app/Contents/Helpers/project-trash'),
           PI_WEB_DEFAULT_WORKSPACE=str(workspace), PI_WEB_PROTECTED_PATHS=str(runtime))
service = dict(Label='com.pi-web', ProgramArguments=[str(runtime / 'pi-web'), '--host', '127.0.0.1'],
               EnvironmentVariables=env, WorkingDirectory=str(workspace), RunAtLoad=True, KeepAlive=True,
               StandardOutPath=str(logs / 'stdout.log'), StandardErrorPath=str(logs / 'stderr.log'))
plist.parent.mkdir(parents=True, exist_ok=True)
with plist.open('xb') as stream:
    os.chmod(plist, 0o600)
    plistlib.dump(service, stream)
if args.start:
    subprocess.run(['launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist)], check=True)
print('Installed Pi Chat and the Mac approval helper. No relay credentials or devices were created.')
print('Open Pi Chat → Settings → Remote control and devices to import your own server configuration.')

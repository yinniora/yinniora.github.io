#!/usr/bin/env python3
"""Build local native bundles. This never approves a device or installs keys."""
from pathlib import Path
import os
import platform
import plistlib
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build/macos.noindex'
MINIMUM_MACOS = '13.0'
architecture = platform.machine()
if architecture not in ('arm64', 'x86_64'):
    raise SystemExit('Build these bundles on a supported Mac architecture.')
build_env = {**os.environ, 'MACOSX_DEPLOYMENT_TARGET': MINIMUM_MACOS}
for name, source, ident, helper in [
    ('Pi Chat', 'PiChat.swift', 'local.pi.chat', False),
    ('Pi Device Approval', 'DeviceApproval.swift', 'local.pi.device-approval', True),
]:
    contents = OUT / (name + '.app') / 'Contents'
    executable = contents / 'MacOS' / name
    executable.parent.mkdir(parents=True, exist_ok=True)
    info = {'CFBundleName': name, 'CFBundleDisplayName': name,
            'CFBundleIdentifier': ident, 'CFBundleExecutable': name,
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '2',
            'CFBundleShortVersionString': '0.0.1',
            'LSMinimumSystemVersion': MINIMUM_MACOS,
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
            'NSHighResolutionCapable': True}
    if helper:
        info['LSUIElement'] = True
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O',
                    '-target', f'{architecture}-apple-macos{MINIMUM_MACOS}',
                    str(ROOT / 'macos' / source), '-o', str(executable)],
                   env=build_env, check=True)
    load_commands = subprocess.check_output(['xcrun', 'vtool', '-show-build', str(executable)], text=True)
    minimum = re.search(r'\bminos\s+(\S+)', load_commands)
    if not minimum or minimum.group(1) != MINIMUM_MACOS:
        raise SystemExit(f'{name}: unexpected executable deployment target')
    subprocess.run(['codesign', '--force', '--sign', '-', str(contents.parent)], check=True)
print('Built macOS 13+ bundles in build/macos.noindex; install only one copy of each.')

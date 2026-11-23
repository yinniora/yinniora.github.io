#!/usr/bin/env python3
"""Build local native bundles. This never approves a device or installs keys."""
from pathlib import Path
import os
import platform
import plistlib
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build/macos.noindex'
MINIMUM_MACOS = '13.0'
architecture = platform.machine()
if architecture not in ('arm64', 'x86_64'):
    raise SystemExit('Build these bundles on a supported Mac architecture.')
build_env = {**os.environ, 'MACOSX_DEPLOYMENT_TARGET': MINIMUM_MACOS}
for name, source, ident, helper in [
    ('YuGo Pi', 'PiChat.swift', 'local.pi.chat', False),
    ('YuGo Pi Approval', 'DeviceApproval.swift', 'local.pi.device-approval', True),
]:
    contents = OUT / (name + '.app') / 'Contents'
    executable = contents / 'MacOS' / name
    executable.parent.mkdir(parents=True, exist_ok=True)
    info = {'CFBundleName': name, 'CFBundleDisplayName': name,
            'CFBundleIdentifier': ident, 'CFBundleExecutable': name,
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '3',
            'CFBundleShortVersionString': '0.1.0',
            'LSMinimumSystemVersion': MINIMUM_MACOS,
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
            'NSHighResolutionCapable': True}
    if helper:
        info['LSUIElement'] = True
    else:
        info['WKAppBoundDomains'] = ['yinniora.github.io', '127.0.0.1']
        info['NSCameraUsageDescription'] = 'Scan a YuGo Pi pairing code.'
        info['NSLocalNetworkUsageDescription'] = 'Connect to a paired YuGo Pi computer on the local network.'
    resources = contents / 'Resources'
    resources.mkdir(exist_ok=True)
    for legal_name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']:
        shutil.copy2(ROOT / legal_name, resources / legal_name)
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    sources = [str(ROOT / 'macos' / source)]
    if not helper:
        sources.append(str(ROOT / 'macos' / 'HostRuntime.swift'))
        sources += [str(ROOT / 'apps/ios/YuGoPi' / name) for name in ['TrustedClient.swift', 'LANSignaling.swift']]
        for page in ['workspace-mode.html', 'offline.html']:
            shutil.copy2(ROOT / 'apps/desktop' / page, resources)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O',
                    '-target', f'{architecture}-apple-macos{MINIMUM_MACOS}',
                    *sources, '-o', str(executable)],
                   env=build_env, check=True)
    load_commands = subprocess.check_output(['xcrun', 'vtool', '-show-build', str(executable)], text=True)
    minimum = re.search(r'\bminos\s+(\S+)', load_commands)
    if not minimum or minimum.group(1) != MINIMUM_MACOS:
        raise SystemExit(f'{name}: unexpected executable deployment target')
    if not helper:
        trash_helper = contents / 'Helpers/project-trash'
        trash_helper.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O',
                        '-target', f'{architecture}-apple-macos{MINIMUM_MACOS}',
                        str(ROOT / 'macos/ProjectTrash.swift'), '-o', str(trash_helper)],
                       env=build_env, check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(trash_helper)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(contents.parent)], check=True)
print('Built macOS 13+ bundles in build/macos.noindex; install only one copy of each.')

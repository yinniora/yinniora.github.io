#!/usr/bin/env python3
"""Build local native bundles. This never approves a device or installs keys."""
from pathlib import Path
import plistlib
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build/macos'
for name, source, ident, helper in [
    ('Pi Chat', 'PiChat.swift', 'local.pi.chat', False),
    ('Pi Device Approval', 'DeviceApproval.swift', 'local.pi.device-approval', True),
]:
    contents = OUT / (name + '.app') / 'Contents'
    executable = contents / 'MacOS' / name
    executable.parent.mkdir(parents=True, exist_ok=True)
    info = {'CFBundleName': name, 'CFBundleDisplayName': name,
            'CFBundleIdentifier': ident, 'CFBundleExecutable': name,
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
            'NSHighResolutionCapable': True}
    if helper:
        info['LSUIElement'] = True
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', str(ROOT / 'macos' / source), '-o', str(executable)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(contents.parent)], check=True)
print('Built native chat window and Mac authentication helper in build/macos')

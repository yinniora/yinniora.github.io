#!/usr/bin/env python3
"""Package a program-only client for an independent HTTPS static host."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'web/dist-remote'
version = json.loads((ROOT / 'package.json').read_text())['version']
manifest_file = OUT / '.vite/manifest.json'
manifest = json.loads(manifest_file.read_text())
assets = set()
visited = set()


def include(key):
    if key in visited:
        return
    visited.add(key)
    entry = manifest[key]
    assets.update('/' + file for file in [entry['file'], *entry.get('css', [])])
    for dependency in entry.get('imports', []):
        include(dependency)


include('remote-index.html')
include('src/main.js')
entry = manifest['src/main.js']['file']
preload = f'<link rel="modulepreload" crossorigin href="/{entry}">'
shell = (OUT / 'remote-index.html').read_text().replace('</head>', f'    {preload}\n  </head>')
for name in ('index.html', '404.html'):
    (OUT / name).write_text(shell)
manifest_file.unlink()
manifest_file.parent.rmdir()
worker = (ROOT / 'web/remote-sw.js').read_text()
worker = worker.replace('pi-remote-personal-1', 'pi-remote-' + version)
worker = worker.replace('/* packaged shell assets */', ', ' + ', '.join(json.dumps(file) for file in sorted(assets)))
(OUT / 'remote-sw.js').write_text(worker)
for name in ['icon.svg', 'icon-maskable.svg']:
    shutil.copy2(ROOT / 'internal/ui/embedded/assets' / name, OUT / name)
(OUT / 'manifest.webmanifest').write_text(json.dumps({
    'id': '/', 'name': 'YuGo Pi', 'short_name': 'YuGo Pi', 'start_url': '/', 'scope': '/',
    'display': 'standalone', 'background_color': '#ffffff', 'theme_color': '#ffffff',
    'icons': [{'src': '/icon.svg', 'sizes': 'any', 'type': 'image/svg+xml'}],
}, indent=2) + '\n')
shutil.copy2(ROOT / 'web/node_modules/jsqr/LICENSE', OUT / 'jsqr-LICENSE.txt')
(OUT / '.nojekyll').touch()
# Android App Links: pairing links open the YuGo Pi app (apps/android). The
# fingerprint is the public certificate of the project's release keystore.
ANDROID_CERT_SHA256 = ('85:BA:88:20:EE:EB:CD:BB:18:74:4C:1E:14:EB:55:34:'
                       '33:B5:6E:87:04:93:DA:D5:FE:DA:9E:E0:57:B9:3D:F6')
(OUT / '.well-known').mkdir(exist_ok=True)
(OUT / '.well-known/assetlinks.json').write_text(json.dumps([{
    'relation': ['delegate_permission/common.handle_all_urls'],
    'target': {'namespace': 'android_app', 'package_name': 'io.github.yinniora.yugopi',
               'sha256_cert_fingerprints': [ANDROID_CERT_SHA256]},
}], indent=2) + '\n')
print('Packaged independent client', version, '; no runtime configuration or credentials included.')

for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']:
    shutil.copy2(ROOT / name, OUT / name)

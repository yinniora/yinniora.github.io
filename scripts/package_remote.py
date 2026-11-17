#!/usr/bin/env python3
"""Package a program-only client for an independent HTTPS static host."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'web/dist-remote'
version = json.loads((ROOT / 'package.json').read_text())['version']
shutil.copy2(OUT / 'remote-index.html', OUT / 'index.html')
shutil.copy2(OUT / 'remote-index.html', OUT / '404.html')
worker = (ROOT / 'web/remote-sw.js').read_text().replace('pi-remote-personal-1', 'pi-remote-' + version)
(OUT / 'remote-sw.js').write_text(worker)
for name in ['icon.svg', 'icon-maskable.svg']:
    shutil.copy2(ROOT / 'internal/ui/embedded/assets' / name, OUT / name)
(OUT / 'manifest.webmanifest').write_text(json.dumps({
    'name': 'Pi Workspace', 'short_name': 'Pi', 'start_url': '/', 'scope': '/',
    'display': 'standalone', 'background_color': '#ffffff', 'theme_color': '#ffffff',
    'icons': [{'src': '/icon.svg', 'sizes': 'any', 'type': 'image/svg+xml'}],
}, indent=2) + '\n')
(OUT / '.nojekyll').touch()
print('Packaged independent client', version, '; no runtime configuration or credentials included.')

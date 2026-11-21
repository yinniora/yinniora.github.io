#!/usr/bin/env python3
"""Collect installed runtime dependency license texts for YuGo distributions."""
from pathlib import Path
import json
import hashlib
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def license_files(directory):
    return sorted(path for path in directory.iterdir() if path.is_file() and
                  (path.name.lower().startswith(('license', 'licence', 'copying', 'notice', 'thirdpartynotice')))
                  and path.stat().st_size < 2_000_000)


def json_stream(text):
    decoder = json.JSONDecoder()
    while text.strip():
        text = text.lstrip()
        value, offset = decoder.raw_decode(text)
        yield value
        text = text[offset:]


def collect():
    sections = []
    inventory = []
    def append(name, version, source, directory, declared='See license text'):
        files = license_files(directory)
        if not files:
            overrides = json.loads((ROOT / 'licenses/overrides.json').read_text(encoding='utf-8'))
            override = overrides.get(name + '@' + version)
            if not override:
                raise RuntimeError(f'No license text for {name}@{version}; inspect before distributing.')
            directory = ROOT / 'licenses' / override['directory']
            files = license_files(directory)
            assert len(files) == 1 and hashlib.sha256(files[0].read_bytes()).hexdigest() == override['sha256']
            source += '\nLicense text source: ' + override['source']
        inventory.append({'name': name, 'version': version, 'license': declared})
        texts = '\n\n'.join(path.name + '\n' + path.read_text(encoding='utf-8', errors='replace') for path in files)
        sections.append(f'{name} {version}\nSource: {source}\nDeclared license: {declared}\n\n{texts}')

    go_root = Path(subprocess.check_output(['go', 'env', 'GOROOT'], encoding='utf-8').strip())
    go_version = subprocess.check_output(['go', 'env', 'GOVERSION'], encoding='utf-8').strip()
    append('Go runtime', go_version, 'https://go.dev/LICENSE', go_root, 'BSD-3-Clause')
    modules = subprocess.check_output(['go', 'list', '-m', '-json', 'all'], cwd=ROOT, encoding='utf-8')
    for module in json_stream(modules):
        if module.get('Main'):
            continue
        if not module.get('Dir'):
            downloaded = json.loads(subprocess.check_output(
                ['go', 'mod', 'download', '-json', module['Path'] + '@' + module['Version']], cwd=ROOT, encoding='utf-8'))
            module['Dir'] = downloaded['Dir']
        append(module['Path'], module['Version'],
               'https://pkg.go.dev/' + module['Path'] + '@' + module['Version'], Path(module['Dir']))

    web = ROOT / 'web'
    package = json.loads((web / 'package.json').read_text(encoding='utf-8'))
    requested = set(package['dependencies']) | {'svelte'}
    inventory_files = list(web.glob('dist*/runtime-licenses.json'))
    if not inventory_files:
        raise RuntimeError('Build the frontend before collecting its runtime licenses.')
    identities = set()
    for inventory_file in inventory_files:
        for item in json.loads(inventory_file.read_text(encoding='utf-8')):
            identities.add((item['name'], item['version']))
    pending = [(name, web) for name in requested]
    for manifest in (web / 'node_modules').rglob('package.json'):
        data = json.loads(manifest.read_text(encoding='utf-8'))
        if (data.get('name'), data.get('version')) in identities:
            pending.append((data['name'], manifest.parent.parent))
    visited = set()
    while pending:
        name, parent = pending.pop()
        directory = None
        for base in [parent, *parent.parents]:
            candidate = base / 'node_modules' / name
            if (candidate / 'package.json').is_file():
                directory = candidate.resolve()
                break
        if directory is None:
            raise RuntimeError(f'Runtime package {name} is not installed.')
        if directory in visited:
            continue
        visited.add(directory)
        data = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        append(data['name'], data['version'], 'https://www.npmjs.com/package/' + data['name'] + '/v/' + data['version'],
               directory, str(data.get('license', 'See license text')))

    header = '''YuGo Pi — third-party notices

YuGo Pi's own and upstream license is in LICENSE; provenance is in NOTICE.
The following texts identify build-resolved Go and browser runtime dependencies.
Dependency source is available from the public module/package/version links.
No dependency's license or attribution is replaced by the YuGo Pi name.
Separate Pi agent / computer-use installations retain their own notices.

'''
    output = header + '\n\n' + ('\n\n' + '=' * 78 + '\n\n').join(sorted(sections)) + '\n'
    (ROOT / 'THIRD_PARTY_NOTICES').write_text(output, encoding='utf-8')
    print(f'Collected original license texts for {len(inventory)} runtime components.')
    return inventory


if __name__ == '__main__':
    collect()

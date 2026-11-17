#!/usr/bin/env python3
"""Create a YuGo release archive, always including licenses and provenance."""
from pathlib import Path
import argparse
import json
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def package_release(binary, target_os, arch, output, root=ROOT):
    legal = [root / name for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']]
    if not binary.is_file() or any(not path.is_file() or not path.stat().st_size for path in legal):
        raise ValueError('Build the binary and collect complete notices before packaging.')
    output.mkdir(parents=True, exist_ok=True)
    name = 'pi-web.exe' if target_os == 'windows' else 'pi-web'
    members = [(binary, name), *[(path, path.name) for path in legal]]
    if target_os == 'windows':
        archive = output / f'yugo-pi-{target_os}-{arch}.zip'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as stream:
            for path, member in members:
                stream.write(path, member)
    else:
        archive = output / f'yugo-pi-{target_os}-{arch}.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            for path, member in members:
                stream.add(path, arcname=member, recursive=False)
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--os', choices=['darwin', 'linux', 'windows'], required=True)
    parser.add_argument('--arch', choices=['arm64', 'amd64'], required=True)
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    archive = package_release(args.binary, args.os, args.arch, args.out)
    print(archive.name, json.loads((ROOT / 'package.json').read_text())['version'])

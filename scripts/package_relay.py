#!/usr/bin/env python3
"""Package the Linux relay and its same-version setup command for distribution."""
import argparse
import io
import json
from pathlib import Path
import tarfile


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    installer_source = (ROOT / 'scripts/install_relay.py').read_text().replace('@YUGO_RELEASE_TAG@', 'yugo-v' + version, 1)
    archive = args.out / f'yugo-pi-relay-linux-{args.arch}.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(args.binary, 'pi-relay', recursive=False)
        tar.add(ROOT / 'scripts/generate_relay_config.py', 'generate_relay_config.py', recursive=False)
        installer_info = tarfile.TarInfo('yugo-pi-relay-install.py')
        installer_info.size = len(installer_source.encode())
        installer_info.mode = 0o755
        tar.addfile(installer_info, io.BytesIO(installer_source.encode()))
        for name in ('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'):
            source = ROOT / name
            if not source.stat().st_size:
                raise ValueError('Build and collect release notices first.')
            tar.add(source, name, recursive=False)
    if args.arch == 'amd64':
        installer = args.out / 'yugo-pi-relay-install.py'
        installer.write_text(installer_source)
        installer.chmod(0o755)


if __name__ == '__main__':
    main()

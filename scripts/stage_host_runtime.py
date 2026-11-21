#!/usr/bin/env python3
"""Assemble pinned public runtime components for a YuGo Pi Host package."""

import argparse
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
NODE_VERSION = "24.22.3"
LEGAL_FILES = ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES")
PI_CLI = Path("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")


def fetch_node(destination, platform, arch, scratch):
    ext = "zip" if platform == "win" else "tar.xz" if platform == "linux" else "tar.gz"
    release = f"node-v{NODE_VERSION}-{platform}-{arch}"
    name = f"{release}.{ext}"
    root = f"https://nodejs.org/dist/v{NODE_VERSION}/"
    with urllib.request.urlopen(root + "SHASUMS256.txt", timeout=30) as response:
        sums = dict((name, checksum) for checksum, name in
                    (line.split() for line in response.read().decode().splitlines()))
    archive = scratch / name
    with urllib.request.urlopen(root + name, timeout=120) as response, archive.open("wb") as file:
        shutil.copyfileobj(response, file)
    with archive.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if digest != sums.get(name):
        raise ValueError("The Node archive checksum does not match its release manifest.")
    if ext == "zip":
        with zipfile.ZipFile(archive) as node:
            node.extractall(scratch)
    else:
        with tarfile.open(archive) as node:
            node.extractall(scratch, filter="data")
    # The package manager is needed by Pi's extension installer.
    unpacked = scratch / release
    for item in unpacked.iterdir():
        if item.name in {"include", "share", "CHANGELOG.md", "README.md"}:
            continue
        item.rename(destination / item.name)


def stage(args):
    output = args.output.resolve()
    if output.exists():
        raise ValueError(f"The staging directory must be new: {output}")
    platform = "win32" if args.platform == "win" else args.platform
    executable = ".exe" if args.platform == "win" else ""
    npm = shutil.which("npm")
    if npm is None:
        raise ValueError("Install Node/npm on the packaging runner.")
    with tempfile.TemporaryDirectory(prefix="yugopi-host-") as temp:
        scratch = Path(temp)
        runtime = scratch / "host"
        runtime.mkdir()
        fetch_node(runtime, args.platform, args.arch, scratch)
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(ROOT / name, runtime / name)
        subprocess.run(
            [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
             f"--os={platform}", f"--cpu={args.arch}"],
            cwd=runtime,
            check=True,
        )
        if not (runtime / PI_CLI).is_file():
            raise ValueError("Bundled Pi executable is missing.")
        for name in ("package.json", "package-lock.json"):
            (runtime / name).unlink()
        (runtime / "LICENSE").rename(runtime / "NODE-LICENSE")
        for name in LEGAL_FILES:
            shutil.copy2(ROOT / name, runtime / name)
        shutil.copy2(args.binary, runtime / f"pi-web{executable}")
        if args.approval:
            shutil.copy2(args.approval, runtime / f"approve-device{executable}")
            if args.platform == "win":
                dotnet = os.getenv("DOTNET_ROOT") or str(Path(shutil.which("dotnet") or "").resolve().parent)
                for name in ("LICENSE.txt", "ThirdPartyNotices.txt"):
                    notice = Path(dotnet) / name
                    if notice.is_file():
                        shutil.copy2(notice, runtime / f"dotnet-{name}")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(runtime, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["darwin", "win", "linux"], required=True)
    parser.add_argument("--arch", choices=["arm64", "x64"], required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--approval", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    stage(parser.parse_args())

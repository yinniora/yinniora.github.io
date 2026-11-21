#!/usr/bin/env python3
"""Package the native Mac host without root-level first-run scripts."""

import argparse
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile


def package(runtime, output, version, arch, application_identity, installer_identity, notary_profile):
    source = Path(__file__).resolve().parent.parent / "build/macos.noindex"
    if bool(application_identity) != bool(installer_identity):
        raise ValueError("Set both the application and installer signing identities.")
    if notary_profile and not installer_identity:
        raise ValueError("Set Developer ID signing identities to notarize the package.")
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-yugo\.(\d+)", version)
    if not match:
        raise ValueError("Use the version from the YuGo package manifest.")
    major, minor, patch, revision = match.groups()
    package_version = f"{major}.{minor}.{patch}{int(revision):04d}"
    binary_version = subprocess.check_output(
        [runtime.resolve() / "pi-web", "-version"], text=True
    ).strip()
    if binary_version != version:
        raise ValueError("The staged backend version does not match the installer version.")
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"yugo-pi-host-{version}-macos-{arch}.pkg"
    with tempfile.TemporaryDirectory(prefix="yugopi-pkg-") as directory:
        payload = Path(directory) / "payload"
        host = payload / "YuGo Pi.app"
        shutil.copytree(source / host.name, host, symlinks=True)
        resources = host / "Contents/Resources/host"
        helpers = host / "Contents/Helpers"
        approval = helpers / "YuGo Pi Approval.app"
        info = host / "Contents/Info.plist"
        metadata = plistlib.loads(info.read_bytes())
        metadata["LSMinimumSystemVersion"] = "13.5"
        metadata["CFBundleShortVersionString"] = ".".join((major, minor, patch))
        metadata["CFBundleVersion"] = revision
        info.write_bytes(plistlib.dumps(metadata))
        shutil.copytree(runtime, resources, symlinks=True)
        shutil.copytree(source / approval.name, approval, symlinks=True)

        identity = application_identity or "-"
        sign = ["codesign", "--force", "--sign", identity]
        if application_identity:
            sign += ["--options", "runtime", "--timestamp"]
        for binary in (resources / "pi-web", helpers / "project-trash"):
            subprocess.run([*sign, str(binary)], check=True)
        subprocess.run([*sign, "--preserve-metadata=entitlements", str(resources / "bin/node")], check=True)
        for extension in resources.rglob("*.node"):
            # npm's optional native modules are platform-specific.
            subprocess.run([*sign, str(extension)], check=True)
        for bundle in (approval, host):
            subprocess.run([*sign, str(bundle)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(host)], check=True)
        components = Path(directory) / "components.plist"
        components.write_bytes(plistlib.dumps([{
            "RootRelativeBundlePath": host.name,
            "BundleHasStrictIdentifier": True,
            "BundleIsRelocatable": True,
            "BundleIsVersionChecked": True,
            "BundleOverwriteAction": "upgrade",
        }]))
        command = [
            "pkgbuild", "--root", str(payload), "--component-plist", str(components),
            "--install-location", "/Applications",
            "--identifier", "io.github.yinniora.yugopi.host", "--version", package_version,
        ]
        if installer_identity:
            command += ["--sign", installer_identity, "--timestamp"]
        subprocess.run([*command, str(destination)], check=True)
        if notary_profile:
            subprocess.run(
                ["xcrun", "notarytool", "submit", str(destination), "--keychain-profile",
                 notary_profile, "--wait"], check=True)
            subprocess.run(["xcrun", "stapler", "staple", str(destination)], check=True)
    print(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=["arm64", "x64"], required=True)
    parser.add_argument("--application-identity", default=os.getenv("YUGO_MAC_APPLICATION_IDENTITY"))
    parser.add_argument("--installer-identity", default=os.getenv("YUGO_MAC_INSTALLER_IDENTITY"))
    parser.add_argument("--notary-profile", default=os.getenv("YUGO_MAC_NOTARY_PROFILE"))
    args = parser.parse_args()
    package(args.runtime, args.output, args.version, args.arch, args.application_identity,
            args.installer_identity, args.notary_profile)

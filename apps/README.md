# YuGo Pi Host and Client apps

Use the Host package on the computer that will run Pi. Use the Client on a
second device to connect to that computer. Both are published through the
[GitHub releases](https://github.com/yinniora/yugo-pi/releases).

## Set up a Host

| Platform | Installer |
| --- | --- |
| macOS 13.5+ | `yugo-pi-host-*-macos-arm64.pkg` (Apple Silicon) or `*-macos-x64.pkg` (Intel) |
| Windows | `yugo-pi-host-*-windows-*-setup.exe` |
| Debian and Ubuntu desktops | `yugo-pi-host-*-linux-*.deb` |

1. Install the package and open YuGo Pi. The window starts the loopback-only
   backend under your user account with the bundled Pi and Node runtime.
2. Open Models and add a provider key if you have yet to configure Pi. The Host
   uses the existing Pi agent directory for models, settings and conversations.
3. Open Devices to configure remote access and approve your first phone. Follow
   the [remote setup guide](../docs/architecture/self-hosted-remote.md) if you
   want your own relay. On Windows, the Host can install Git Bash through
   WinGet on first launch if Pi has no shell configured.

The macOS package installs the window with its approval helper and starts the
service as the logged-in user on first launch. A new Mac install defaults to
`/Applications`. The installer can also replace a registered YuGo Pi window
in place, including one in `~/Applications`, using its existing bundle ID.
For a legacy install, the existing LaunchAgent and any standalone approval
helper it uses stay available. Linux and Windows use an app
tray to keep the backend running after the window is closed. An existing
authenticated local service can be opened without overwriting its settings.
Mac and Linux hosts keep a writable per-user backend for in-place YuGo
updates. The bundled runtime and approval helper stay in the installed app.
Use the native app menu to find the current YuGo installer release.

## Get a Client

| Platform | File | Notes |
| --- | --- | --- |
| Android 8+ | `yugo-pi-client-*-android.apk` | Signed with the project keystore, so later versions install over earlier ones |
| Windows 10/11 | `*-windows-x64-setup.exe`, `*-windows-arm64-setup.exe`, `*-windows-x64-portable.exe` | Unsigned |
| macOS 12+ | `*-mac-arm64.dmg`/`.zip` (Apple Silicon), `*-mac-x64.dmg`/`.zip` (Intel) | Ad-hoc signed, not notarized |
| Linux | `*.AppImage`, `*.deb` (x64, arm64) | |
| iOS and iPadOS 16+ | [Native Xcode project](ios/README.md) | Apple signing is required for device distribution. In Safari, open <https://yinniora.github.io/> and choose Share › Add to Home Screen |

The Android, Windows, macOS and Linux client apps all open the published
encrypted remote client at <https://yinniora.github.io/>. Each app keeps its own
pairing, so the first time you open it, pair it the same way as a browser:

1. On the Mac, create a pairing QR code (Settings › Devices).
2. In the app, scan the code with the camera, or paste the pairing link.

The apps never contain host credentials. The pairing keys live in the web
client's storage inside each app, just as they do in a browser.

The desktop Client menu checks for a release for your operating system and CPU.
Choose Download Update to verify the published size and SHA-256 digest and open
the installer with your system. For a portable build or an AppImage, the menu
reveals the verified file for you to open. Client updates reuse the current app
profile and its paired devices.

On Android, opening a pairing link (`https://yinniora.github.io/#pair=…`) opens
it in the app.

## First launch on unsigned builds

- **macOS:** right-click the app › Open › Open. If macOS still blocks it, go to
  System Settings › Privacy & Security and click Open Anyway. Or run
  `xattr -dr com.apple.quarantine "/Applications/YuGo Pi Client.app"`.
- **Windows:** when SmartScreen appears, click More info › Run anyway.
- **Android:** allow installing apps from your browser or file manager when
  prompted.

## Building locally

```sh
cd apps/desktop && npm ci && npx electron-builder --mac   # or --win / --linux
cd apps/android && gradle assembleRelease                 # needs JDK 17 and the Android SDK
```

Without the `ANDROID_KEYSTORE_*` environment variables, the APK is signed with
the debug key. A debug-signed APK cannot upgrade a release install.

The full Host build is defined in `.github/workflows/host-apps.yml`. It stages
Node from a verified upstream distribution and Pi from the root lockfile.
The macOS packager supports signing with Developer ID Application and
Installer identities and notarizing with an existing keychain profile. The
default build is intended for development without these credentials.

# YuGo Pi apps

## Desktop

Install **YuGo Pi** from [GitHub releases](https://github.com/yinniora/yugo-pi/releases)
on either computer. Current installers have `host` in the asset filename for
compatibility with existing updaters.

| Platform | Installer |
| --- | --- |
| macOS 13.5+ | `yugo-pi-host-*-macos-arm64.pkg` (Apple Silicon) or `*-macos-x64.pkg` (Intel) |
| Windows | `yugo-pi-host-*-windows-*-setup.exe` |
| Debian and Ubuntu desktops | `yugo-pi-host-*-linux-*.deb` |

1. Install the package, open YuGo Pi and choose **Run Pi on this computer**.
   The app starts the loopback-only backend under your user account with the
   bundled Pi and Node runtime.
2. Open Models and add a provider key if you have yet to configure Pi. The Host
   uses the existing Pi agent directory for models, settings and conversations.
3. Open Devices to configure remote access and approve your first phone. Follow
   the [remote setup guide](../docs/architecture/self-hosted-remote.md) if you
   want your own relay. On Windows, the Host can install Git Bash through
   WinGet on first launch if Pi has no shell configured.

The macOS package installs the window with its approval helper. Local mode
starts the service as the logged-in user. A new Mac install defaults to
`/Applications`. The installer can also replace a registered YuGo Pi window
in place, including one in `~/Applications`, using its existing bundle ID.
For a legacy install, the existing LaunchAgent and any standalone approval
helper it uses stay available. Linux and Windows use an app
tray to keep the backend running after the window is closed. An existing
authenticated local service can be opened without overwriting its settings.
Native Host windows rely on the user's local service listening on port 31415.
On a multi-user host, other local accounts share the loopback network. They
should be within the trust boundary for this local connection.
Mac and Linux hosts keep a writable per-user backend for in-place YuGo
updates. The bundled runtime and approval helper stay in the installed app.
Use the native app menu to find the current YuGo installer release.

On first launch, choose **Run Pi on this computer** to work locally or
**Connect to another computer** to pair and open a remote workspace. Change
your choice in **Settings → Connections → Desktop mode** or the native app
menu. Switching to a remote workspace leaves a running local host available
to its paired devices. When only using a remote workspace after launch, the app
starts without a local host.

An existing desktop host opens in local mode on upgrade and keeps its projects,
preferences and paired devices. Before installing over a previous desktop
client, close it. Windows and Linux reuse the previous client profile. A
previous Mac desktop client uses Chromium storage, so pair once in the new
native Mac window to establish its WebKit pairing.

## Remote apps for phones and tablets

| Platform | File | Notes |
| --- | --- | --- |
| Android 8+ | `yugo-pi-client-*-android.apk` | Signed with the project keystore |
| iOS and iPadOS 16+ | [Native Xcode project](ios/README.md) | Apple signing is required for device distribution. In Safari, open <https://yinniora.github.io/> and choose Share › Add to Home Screen |

In desktop remote mode or on a phone or tablet, open **Settings → Devices**
on the host, create a pairing QR code, and scan it or paste the pairing link
in the remote app. The client keeps its own pairing. The native apps can use
the same local network once LAN access is enabled on the host. The browser
client can use Tailscale or a configured relay.

On Android, opening a pairing link opens it in the app. The website keeps
its existing pairing when updating from an earlier version.

## First launch on unsigned builds

- **macOS:** open the package from Finder. If macOS blocks it, go to
  System Settings › Privacy & Security and click Open Anyway.
- **Windows:** when SmartScreen appears, click More info › Run anyway.
- **Android:** allow installing apps from your browser or file manager when
  prompted.

## Building locally

```sh
cd apps/android && gradle assembleRelease                 # needs JDK 17 and the Android SDK
```

Without the `ANDROID_KEYSTORE_*` environment variables, the APK is signed with
the debug key. A debug-signed APK cannot upgrade a release install.

The full Host build is defined in `.github/workflows/host-apps.yml`. It stages
Node from a verified upstream distribution and Pi from the root lockfile.
The macOS packager supports signing with Developer ID Application and
Installer identities and notarizing with an existing keychain profile. The
default build is intended for development without these credentials.

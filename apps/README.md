# YuGo Pi platform apps

Every tagged release (`yugo-v*`) attaches these builds to its
[GitHub Release](https://github.com/yinniora/yugo-pi/releases). They are built
by `.github/workflows/apps.yml`. None of them uses a paid signing identity.

| Platform | File | Notes |
| --- | --- | --- |
| Android 8+ | `yugo-pi-client-*-android.apk` | Signed with the project keystore, so later versions install over earlier ones |
| Windows 10/11 | `*-windows-x64-setup.exe`, `*-windows-arm64-setup.exe`, `*-windows-x64-portable.exe` | Unsigned |
| macOS 12+ | `*-mac-arm64.dmg`/`.zip` (Apple Silicon), `*-mac-x64.dmg`/`.zip` (Intel) | Ad-hoc signed, not notarized |
| Linux | `*.AppImage`, `*.deb` (x64, arm64) | |
| macOS host | `yugo-pi-host-app-*.zip`, `yugo-pi-approval-app-*.zip` | Native windows for the Mac that runs the server |
| iOS | — | Not packaged: installing outside the App Store needs a paid Apple Developer account. In Safari, open <https://yinniora.github.io/> and choose Share › Add to Home Screen |

## Client apps

The Android, Windows, macOS and Linux client apps all open the published
encrypted remote client at <https://yinniora.github.io/>. Each app keeps its own
pairing, so the first time you open it, pair it the same way as a browser:

1. On the Mac, create a pairing QR code (Settings › Devices).
2. In the app, scan the code with the camera, or paste the pairing link.

The apps never contain host credentials. The pairing keys live in the web
client's storage inside each app, just as they do in a browser.

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

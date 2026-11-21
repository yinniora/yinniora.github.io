# YuGo Pi for Android

Install the Android APK from the [YuGo Pi releases page](https://github.com/yinniora/yugo-pi/releases) and scan the pairing code displayed by your host. The Android app retains pairing locally across updates.

For local Wi-Fi, enable the LAN route on the host, connect the Android device to the same network, and scan the same pairing code from the app. The app verifies the host's LAN TLS certificate against the code before starting the existing encrypted session and device approval. A code that includes Tailscale or a VPS also works through those routes. Update Android System WebView if LAN pairing is unavailable on an older installation.

Open the app’s top-right menu and select **Check app update**. The app downloads the selected YuGo release APK, checks GitHub’s SHA-256 digest and the installed app’s signing certificate, then opens the Android system installer. On the first update, Android may ask you to allow YuGo Pi to install apps. Confirm the update in the system installer and reopen YuGo Pi when installation finishes.

Release APKs need to use the same Android signing key across builds. Configure the repository’s `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets for release builds. Local debug APKs must be updated through their original build and install channel.

# YuGo Pi for iPhone and iPad

The iOS app opens the encrypted YuGo Pi client at `https://yinniora.github.io/`.
Its camera reads pairing codes on the device, and the host still approves each
device with system authentication. Pairing stays in the app's own WebKit
storage. On first use, generate a new code on the host and scan it inside the
app. The existing pairing-link field also works inside the app.

The app requires iOS 16 or later. Native scanning uses VisionKit on supported
devices. Other devices can paste the pairing link. The scanner reads YuGo Pi
codes for the separately hosted client origin, while WebRTC verifies the host
identity and device approval using the same protocol as the web app.

For local Wi-Fi, enable the host's local connection, scan its code and allow local-network access
when iOS prompts. The native app accepts signals only from a private IPv4
endpoint secured by the host certificate in the pairing code. The same
connection still requires the host's approved-device challenge.

## Build and test

Open `YuGoPi.xcodeproj` in Xcode, choose the `YuGoPi` scheme and run on an iPhone
simulator or your registered device. Camera testing needs a real device.

```sh
xcodebuild -project apps/ios/YuGoPi.xcodeproj -scheme YuGoPi \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The GitHub workflow runs a simulator build and pairing-link and LAN endpoint
tests without signing credentials. For a physical-device build, select your Apple Developer
team under Signing & Capabilities and use the bundle identifier registered for
that team. Supply the release's marketing version and increment the build
number before archiving. Use Xcode Organizer to upload the signed archive to
App Store Connect for TestFlight or App Store review.

Distribute native shell updates through the same TestFlight or App Store app
record so iOS preserves its app data. The independently hosted client code
updates through the existing web client on launch. Safari's **Add to Home
Screen** remains the web distribution path and uses its own device pairing.

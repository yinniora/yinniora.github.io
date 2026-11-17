<!-- Machine-translated from the root English README. -->
# YuGo Pi

[中文](user-docs/readme/README.zh.md) · [License](LICENSE) · [Upstream](https://github.com/ygncode/pi-web)

YuGo Pi is an independently maintained, MIT-licensed variant of **pi-web**,
originally created by **Set Kyar Wa Lar (YGNCode)**. It is not an official
pi-web or Pi release. The upstream copyright and license remain intact.

The project is maintained at [yinniora/yugo-pi](https://github.com/yinniora/yugo-pi).
Bug reports and contributions for this variant belong in this repository.

## What YuGo Pi adds

- A native Mac conversation window and a mobile Home Screen web app.
- Projects and conversations on the phone home screen, project menus and new
  conversation controls, persistent collapse, and a clear Home return action.
- Stable mobile keyboard layout, bounded scrolling and page zoom protection.
- Expandable model thinking and tool activity, image/SVG zoom, native video
  and audio, file downloads, and a separate BTW side chat with an introduction
  and explicit attachment of replies to the main draft.
- Conversation Trash and permanent deletion, optional verified generated-file
  cleanup, and optional project-folder moves to Mac Trash with confirmation.
- Mac-authenticated one-time pairing, device approvals, revocation and precise
  device details. Your Mac owns the identity and access decisions.
- Your own authenticated relay, automatic P2P attempts, encrypted WebRTC/DTLS,
  actual P2P/Relay status, and synchronization/loading indicators.

## Build and install

Prerequisites: Go from `go.mod`, Node/npm, a configured Pi coding agent, and
Xcode Command Line Tools for the native Mac window. No model keys, devices,
relay credentials or certificates are distributed with the source.

```bash
git clone https://github.com/yinniora/yugo-pi.git
cd yugo-pi
make check
make build remote-build VERSION=0.1.0-yugo.1
python3 scripts/collect_notices.py
python3 scripts/build_macos.py
python3 scripts/install_remote_macos.py --client https://YOUR-INDEPENDENT-CLIENT/
```

The fresh Mac installer refuses to overwrite an existing installation. Existing
users should follow the [migration and maintenance guide](docs/maintenance.md).
The internal `pi-web` binary name and data paths remain compatible so upgrades
do not reset conversations, approvals, keys or existing pairing origins.

For phone access and your own server, see the
[self-hosted remote guide](docs/architecture/self-hosted-remote.md) and
[security architecture](docs/architecture/remote-security.md). The independently
hosted phone program must remain separate from an untrusted relay.

## Upstream updates without replacing YuGo changes

YuGo Pi has its own `yugo-v*` releases. Runtime updates are manual; the app and
Pi extension do not install the upstream npm package. Official changes are
fetched into an isolated review worktree:

```bash
python3 scripts/sync_upstream.py check
python3 scripts/sync_upstream.py prepare
```

The script never resets or merges into your working main branch. Conflicts
stay in the review worktree for explicit resolution. Review the diff, run the
variant checks, full tests and mobile regressions, then merge the reviewed PR.
Upstream changes can conflict; no update is accepted merely because it is newer.
See [maintenance](docs/maintenance.md) for the complete process.

## License and provenance

YuGo Pi retains the upstream [MIT license](LICENSE), author attribution and
Git history. [NOTICE](NOTICE) distinguishes this derivative from upstream.
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) accompanies distributed clients,
native apps and release archives. Separate tools and model services remain
subject to their own licenses and terms.

Historical upstream guides and translations are retained for reference; the
root README, YuGo maintenance guide and self-hosted guide describe this variant.

# Contributing to YuGo Pi

YuGo Pi is independently maintained at https://github.com/yinniora/yugo-pi.
Open bugs and feature requests here; upstream maintainers are not responsible
for this variant. For substantial changes, open an issue to agree on scope.
Pull requests should target `main`, describe the resulting behavior and include
relevant validation. Run `make check` before submitting. Preserve the MIT
license, original attribution and third-party notices. Do not commit credentials,
pairing QR data, private relay addresses or user conversations.

Upstream synchronization uses the isolated worktree process in
[maintenance](docs/maintenance.md). Resolve conflicts explicitly and verify the
YuGo contracts and mobile/security regressions before merging. Proposing a
change to the upstream project must follow that project's own contribution rules.

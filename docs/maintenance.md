# Maintaining YuGo Pi

YuGo Pi is the independently maintained variant at
https://github.com/yinniora/yugo-pi, with `main` as the maintained branch and
`yugo-v*` as its release tags. Upstream is https://github.com/ygncode/pi-web.
The original MIT license and author attribution must be preserved. This
repository keeps full ancestry and its GitHub fork relationship for provenance.

## Review an official update

1. Commit or stash local work; keep a backup of your runtime configuration.
2. Run `python3 scripts/sync_upstream.py check`. It only fetches official `main`.
3. Run `python3 scripts/sync_upstream.py prepare`. It creates a separate
   `review/upstream-<commit>` branch and sibling worktree, then performs an
   uncommitted three-way merge there. Your main checkout and installed app are
   untouched. Conflicts remain in the review worktree; no side is chosen for you.
4. Inspect every change. Keep YuGo project/session management, mobile viewport
   behavior, media, BTW, privacy boundaries and Mac-approved device security.
   Never resolve the entire merge with `--theirs`, reset to upstream or use a
   force-sync operation. A renamed upstream module still needs a reviewed
   migration of our behavior and regression coverage.
5. In that worktree, run `make check`, `make build remote-build`, native Mac
   builds where relevant, and the mobile regressions described in
   [E2E testing](dev/e2e-testing.md). Test simulated and real phone keyboard
   behavior before promoting an update that changes layout.
6. Commit the resolved merge, push the review branch to your own repository,
   and open a PR targeting `main`. Include the upstream commit, resolved
   conflicts, retained YuGo features and test results. Merge only after review.

`make check` includes YuGo identity/update-policy contracts and regression files.
Tests and an isolated worktree prevent automatic replacement, but do not make
upstream changes conflict-free; human review remains necessary.

## Publish a YuGo release

Use an independent semantic version such as `0.1.0-yugo.1`; update both root
package manifests. Build with that version and tag it `yugo-v0.1.0-yugo.1`.
The release workflow builds YuGo archives from our repository, includes LICENSE,
NOTICE and THIRD_PARTY_NOTICES, and does not publish the upstream npm package.
Do not reuse an official version number or point an installer at upstream.

The YuGo Web Client workflow builds the encrypted browser app from the release
tag. On the account's Pages repository it deploys that build after the release
is published, and can also run from the maintained branch for a site rebuild.
The site keeps its root URL, manifest ID and service-worker scope for installed
Home Screen apps. The Docs workflow packages a preview of the documentation
site for download.

The Mac service automatically checks the public official `main` commit three
seconds after startup and every six hours thereafter. This is read-only metadata
tracking without GitHub tokens, model calls, Git operations or installation. The
Mac and phone version dialog shows the result, last successful check and a review
link; new commits produce a dismissible reminder. Network failures retain the
last known reminder and never claim the app is current. The browser refreshes
the cached status every minute while visible and when returning to the app.

The integrated official base is recorded in `variant.json` and
`internal/updater/upstream-base.txt`; update both only after completing the
review and merge. Checks compare official commits against this base, not YuGo's
independent release version.

The host version dialog checks our published releases separately. **Download and
install update** checks the release artifact's size and SHA-256. Compatible
macOS and Linux installs can stage only the backend, keep its previous binary,
and restart after Pi is idle. Full host updates open the operating system's
installer. The package and backend both preserve the existing workspace state.
The release includes `yugo-backend-compatibility.json`. Increment the
compatibility level when a backend requires updated bundled runtime or native
helpers, and update the backend's expected level for hosts installed with that
full package. Official upstream fetches and reviews are metadata-only and never
apply an update. Use the preserved executable for a binary rollback while
keeping the current database, conversations and approved devices.

## Existing personal-fork installations

The former `personal/main` history and `personal.*` tags remain in Git history.
YuGo Pi keeps the `pi-web` executable/API identifiers, `com.pi-web` launch job,
`local.pi.chat` and `local.pi.device-approval` bundle IDs, settings keys, database,
origin and DTLS/device identity paths for compatibility. These internal names
are not a separate public update channel.

A Mac app rename must move to one `YuGo Pi.app` and one `YuGo Pi Approval.app`,
update helper paths in the existing launch configuration, and preserve every
credential, project, conversation and approval. The legacy developer installer
is for clean setups. The full Host package declares the existing `local.pi.chat`
bundle relocatable, so Installer can upgrade a recognized window in its current
location. Its first launch reuses the existing LaunchAgent. Keep the older
standalone approval helper installed while that job references it. When moving
an older window manually, update any helper paths in the job before archiving
the old bundle. Existing iPhone Home Screen labels may
need a manual display-name edit; keep the same entry URL and app ID to preserve
paired browser storage.

Windows hosts create remote identity and configuration files with an owner-only
protected DACL. The loader verifies that DACL and the current owner before use.
POSIX hosts require owner-only mode and the current owner. Keep these checks
when migrating or restoring host credentials.

The Pi CLI and optional computer-use package are independent dependencies.
Their own update, license and permission policies are not changed by YuGo Pi.

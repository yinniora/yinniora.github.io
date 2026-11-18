# Device-authenticated remote workspace

This personal fork treats every relay, including a compromised VPS, as untrusted.
The trusted endpoints are the Mac and the independently hosted HTTPS client.
The client's publisher account and the Mac/browser operating systems are in the
trust boundary. A relay compromise can interrupt service and observe connection
metadata. It must not grant workspace access or expose conversation/media content.

## Enrollment and credentials

`PI_WEB_DEVICE_AUTH=1` gates all non-loopback application HTTP, including an old
shared token or a request with spoofed forwarding headers. `/remote-signal` is a
signaling endpoint, not an application API. Approved remote requests enter with
an internal context marker which cannot be supplied by a header.

A local authenticated administrator requests a QR code from Devices. The helper
configured by `PI_WEB_PAIR_APPROVER` must complete macOS LocalAuthentication for
every request. Cancellation, lock-screen unavailability or a missing helper fail
closed. Approval creates a three-minute, single-use ticket stored only as a hash
in memory. The QR's URL fragment carries the ticket, pinned Mac fingerprint and
public connection metadata. It is not transmitted to the static host. Treat the
visible QR as a temporary credential and scan it only on your own device.

New desktop clients request compact v2 QR payloads (the same 256-bit pin/ticket,
expiry, relay capability and routes encoded without duplicate field names).
Nonstandard routes and older desktop clients retain v1; phone clients accept
both. No private key is encoded, and URL fragments/tickets are never persisted.
Camera decoding prefers a supported native QR detector, with a local jsQR
fallback, central higher-resolution crops and periodic full-frame/inverted scans.

Connection UI reports identity, ICE credentials, signaling, candidate gathering,
Mac answer, encrypted-channel, device-proof and initial-sync stages separately.
Copyable diagnostics contain build/mode/time, stage, HTTP status and candidate
counts/state only; no URL, key, ticket, fingerprint or user content. Relay-only
connections fail promptly when credentials are unavailable instead of attempting
an impossible ICE session. Offer/answer and channel/auth timers have independent
budgets; usable TURN candidates can be sent before all interfaces finish gathering.
Authentication denial is allowed to drain before DTLS closes. Mac signaling has
bounded heartbeat/reconnect and periodic authoritative-whitelist synchronization.

The Mac's persistent self-signed DTLS **leaf** key lives in
`~/.pi/agent/remote/identity.pem`, mode 0600. It is never sent to the VPS; there is
no custom CA or iPhone certificate profile to install. Backing up or replacing
this identity is a Mac administration task; replacing it requires re-pairing.

The browser generates a non-extractable P-256 private CryptoKey in IndexedDB.
The Mac stores its public key, device name, precise enrollment/connection times
and coarse system/browser/app labels. Full user agents, hardware models and
locations are not collected. Removed devices disappear from the list and lose
Mac and relay access.
Clearing browser website data loses that identity and requires another Mac
approval. Revocation immediately closes active channels and cancels their HTTP
requests. A remote device cannot generate QR codes or approve another device.

The installed Home Screen app has its own website storage and must enroll inside
that app, even if the browser was already paired. Its unconnected screen offers
local camera QR decoding, a copied-link fallback and retry. Camera frames never
leave the device or enter WebRTC media tracks; the stream stops on cancel,
successful scan, backgrounding or teardown. A copied link has the same short
lifetime and one-use rule as the QR. Pairing tickets are removed from the URL
fragment immediately and are never persisted with the public connection data.
An already-approved key can recover after losing the enrollment response; a
spent ticket cannot enroll a different key. Concurrent windows share one
IndexedDB identity through a serialized creation transaction. Static navigation bypasses
the browser HTTP cache so a Home Screen relaunch receives the current program;
only the public shell/assets have an offline cache.

## Transport

The independent static client verifies **every** SHA-256 fingerprint in SDP
against the QR pin before passing SDP to native WebRTC. DTLS verifies possession
of the corresponding Mac private key. Inside that encrypted channel a fresh
nonce is signed by the device using domain-separated ECDSA SHA-256. A signature
from a different nonce or Mac does not authenticate.

Only after whitelist verification may the channel carry bounded, multiplexed
HTTP requests. Headers cannot import cookies, bearer tokens or a forged admin
identity. Files, downloads, SSE and native video Range requests all take this
same encrypted route, including requests mediated by the client's service
worker. No plaintext API or media fallback is used. Flow control bounds unread
responses; canceled requests cancel work on the Mac. Reconnection never retries
mutating requests automatically.

ICE prefers available direct LAN/Tailscale routes. TURN over UDP or TCP is the
fallback. The client accepts TURN instructions only for the configured relay
host and port. The VPS runs the small `pi-relay` signaling broker and Coturn. It
receives only public device-key IDs/proofs, disposable routing/TURN credentials,
SDP and DTLS ciphertext,
**not** Pi tokens, model keys, device private keys or the Mac identity key.
Outer HTTPS certificates protect signaling availability and metadata; losing a
VPS HTTPS key cannot impersonate the pinned inner DTLS identity.

One entry named Pi offers Automatic, Tailscale and VPS preferences. Automatic
races direct and public signaling and allows direct ICE routes; Tailscale uses
the private signaling endpoint when configured, otherwise the existing public
signaling endpoint, and requests no client TURN servers. This preference works
without changing tailnet settings; available direct candidates remain preferred.
VPS uses
public signaling and relay-only ICE. Switching routes keeps the same pinned
identity and device approval. An authenticated metadata refresh can update the
direct endpoint, but cannot change the pinned Mac identity.

Do not forward a Mac HTTP listener through SSH or serve this client program
from the VPS. Use a separately controlled HTTPS static host. Remove obsolete
reverse HTTP tunnels during migration; otherwise loopback forwarding can bypass
network-origin checks. The Mac initiates its signaling connection outbound.

## Build and runtime configuration

`make build VERSION=0.0.1-beta.38-personal.1` builds the Mac server; `make
remote-build` emits the program-only client in `web/dist-remote`. Publish that
directory to a separate HTTPS origin with root service-worker scope. It contains
no private runtime configuration. `make build-relay` builds the standalone
broker (no embedded frontend required). `python3 scripts/build_macos.py` builds
the native window and authentication helper in `build/macos.noindex`; install
both locally. The builder explicitly targets macOS 13 and checks the Mach-O
minimum OS, regardless of the invoking shell's deployment-target environment.
The `.noindex` build directory keeps build copies out of application search.
Archive old backup bundles rather than leaving extra `.app` directories in
indexed workspaces, and register only the installed copies with LaunchServices.

Mac environment variables: `PI_WEB_DEVICE_AUTH`, `PI_WEB_PAIR_APPROVER`,
`PI_WEB_REMOTE_CLIENT_URL`, `PI_WEB_REMOTE_SIGNAL_URL`, `PI_WEB_REMOTE_ICE_URL`,
`PI_WEB_REMOTE_TURN_IP`, `PI_WEB_REMOTE_TURN_SECRET`, `PI_WEB_RELAY_HOST_TOKEN`,
`PI_WEB_RELAY_CLIENT_SECRET`. Mac-authenticated server changes are stored
privately in `remote/connection.json` and applied without replacing the Mac
identity. See [self-hosted remote setup](self-hosted-remote.md).
Optional `PI_WEB_PROJECT_TRASH_HELPER` points to the native `Contents/Helpers/project-trash` executable inside Pi Chat. `PI_WEB_PROTECTED_PATHS` is an OS path-list of additional runtime/configuration locations whose ancestors must not be moved by project deletion. The helper moves folders to Finder Trash; no shell or UI scripting is used.
`PI_WEB_REMOTE_DIRECT_URL` is an optional trusted HTTPS/WSS direct signaling
endpoint. Point Tailscale Serve at the separate signaling-only loopback listener
configured by `PI_WEB_DIRECT_SIGNAL_ADDR`, never at the workspace HTTP port.
The browser races direct and public signaling, so Tailscale can work even when
the VPS is offline. Keep all credentials in local mode-0600 runtime configuration.

Broker variables: `PI_RELAY_ROOM`, `PI_RELAY_HOST_TOKEN`, `PI_RELAY_TURN_SECRET`,
`PI_RELAY_PUBLIC_IP`, `PI_RELAY_CLIENT_ORIGIN`, `PI_RELAY_CLIENT_SECRET`.
The broker requires device ECDSA challenge proofs before signaling and signed,
replay-protected requests before issuing TURN credentials. The Mac synchronizes
approved key IDs over its authenticated host connection. New pairing receives a
separate short-lived relay capability; the Mac pairing secret never reaches the
relay. See [self-hosted remote setup](self-hosted-remote.md). The service binds loopback
127.0.0.1:43120 behind HTTPS; the room is a high-entropy routing identifier.
Coturn must use short-lived REST authentication, allocation/bandwidth quotas,
and deny loopback/private/link-local peer destinations. Do not enable a public
unauthenticated TURN relay.

Personal versions disable upstream automatic checks/install. Review upstream
changes in Git, test them, then publish a new personal version. Never store real
sessions, keys, addresses, machine-specific configuration or private media in
these public source/client repositories.

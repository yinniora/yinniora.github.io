# Remote control with your own server

The same Pi phone client supports different Mac owners and relay servers. The
UI is named Pi. It tries P2P over available interfaces (including private network
interfaces) and falls back to the configured relay. The small connection label
shows the **selected WebRTC candidate pair** as P2P or Relay, independently of the
chosen preference. It does not claim to identify an underlying VPN's transport.

## Install on a Mac

Configure the Pi CLI and a model service first. Build this fork on the Mac:

```sh
make build
python3 scripts/build_macos.py
python3 scripts/install_remote_macos.py --start
```

The fresh installer refuses to replace an existing installation. It creates a
private local token, installs YuGo Pi and the LocalAuthentication helper, and
binds workspace HTTP to loopback only. It does not enroll a device or expose a
workspace port. Existing installations should keep their identity, launch agent
and model configuration when updating their binaries.

The default independent client is https://yinniora.github.io/. Operators can
publish `make remote-build` output to their own independent HTTPS origin and
supply it with the installer's `--client` option. Keep this program origin separate
from the relay; a compromised relay must not be able to replace the phone code.

## Prepare a relay

One broker instance serves one Mac owner. It has no Mac identity key, model key,
workspace token, conversation data or private media. Build `make build-relay`
for the server architecture. Generate private configuration outside a checkout:

```sh
python3 scripts/generate_relay_config.py \
  --server https://relay.example.com \
  --client https://yinniora.github.io/ \
  --out /secure/path/pi-relay-private
```

The generator creates mode-0600 `relay.env`, `connection.json` and
`turnserver.conf` inside a mode-0700 directory, with independent random routing,
host, enrollment and TURN values. It refuses to overwrite keys. Use `relay.env`
as the broker's systemd EnvironmentFile; run `pi-relay` as an unprivileged service.
The broker listens only on `127.0.0.1:43120`. Use a valid HTTPS reverse proxy
(domain or IP certificate); proxy `/signal` with WebSocket support and `/ice`
and `/verify` to that loopback port. Do not proxy any Mac HTTP service.

Run Coturn with the generated configuration. Open only HTTPS, TURN 3478 UDP/TCP,
and the bounded UDP relay range 49160–49220 needed for this service. Coturn's REST
shared secret must match `PI_RELAY_TURN_SECRET`. `PI_RELAY_PUBLIC_IP` identifies
the TURN host and must match the HTTPS server hostname; it may be a DNS name.
Set Coturn's public/private address mapping separately if the host is behind NAT.
Keep authentication, allocation/bandwidth quotas and private-peer denials enabled;
see [Coturn's option reference](https://github.com/coturn/coturn/wiki/turnserver).
The local HTTPS proxy must overwrite `X-Forwarded-For` with the real remote
address, pass `Authorization`, and allow authenticated `/ice`
preflights from the configured independent client origin.

## Configure Pi

On the Mac, open Settings → Remote control and devices, or Devices → Remote
control and devices. Import the contents of the private `connection.json`, review
the HTTPS server address, then authenticate to verify and save. The native Mac
prompt names the destination. Saving validates HTTPS, host authentication,
TURN/enrollment secret proofs and the trusted client origin before atomically
writing `~/.pi/agent/remote/connection.json` mode 0600. Secret fields are never
returned by GET, saved to browser storage, or copied to a different server when
left blank. The Mac identity and device approvals stay unchanged. Online clients
receive updated public routing metadata over the authenticated channel; an
offline client may need a fresh Mac QR after its old server is retired.

Generate a pairing QR only after Mac authentication. In the iPhone Home Screen
Pi app, tap Scan QR code. The browser and Home Screen app have separate keys.

## Protect all three endpoints

Knowing an IP, port or routing ID is insufficient for relay or TURN access.
The broker verifies fresh ECDSA device proofs against a public-key-ID whitelist
sent by the authenticated Mac host. ICE credentials require a timestamped proof
with replay protection. First enrollment uses a separate three-minute relay
capability bound to one device key. This capability cannot approve a device on
the Mac: the Mac pairing secret stays inside the pinned DTLS channel. Relay and
Mac signatures use different domains, so a relay cannot repurpose one as the
other. Host authentication and configuration verification use a separate secret.

Removal disconnects the Mac and relay sessions and removes the approved key.
A relay restart restores its whitelist from the Mac. Limits bound pending/active
connections, request rates, replay/enrollment records and handshake duration.
TURN uses expiring credentials and separate allocation/bandwidth limits; an
already-issued TURN credential can remain valid until its expiry, but grants no
Mac workspace access. A compromised relay can interrupt service and observe
connection metadata; it cannot impersonate the pinned Mac or approve a device.

The phone's Mac-folder picker reads directory names under the Mac account home,
with symlink confinement and bounded listings. Files remain on the Mac. Other
project paths can be entered manually, or added on the Mac then refreshed on the
phone. Device cards show enrollment/last-connection times with timezone, coarse
system/browser/app labels, a short key ID and current connection presence.

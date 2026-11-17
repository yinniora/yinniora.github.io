# Session management and connection switching

Open the menu beside a session card to rename the conversation, export its
user/assistant text as Markdown, move it to Trash, or permanently delete it.
The same actions are available from the session viewer's menu. Desktop menus
and mobile sheets use the selected theme.

Moving a conversation to Trash hides it in the browser. The original Pi JSONL
stays in place, so it can be restored without rewriting the conversation.
Trash is available from the home menu and the session viewer. Terminal Pi
sessions still see the underlying files.

Permanent deletion requires a second confirmation. It removes the conversation
JSONL and its queued messages, annotations and review comments. Project files
are preserved. Stop running tasks before deleting a conversation. Deletion
does not remove previously exported files or external copies.

## Shared preferences

Language and other supported preferences are shared by browsers connected to
the same server. On a fresh origin, pi-web reads these settings before rendering
the app so switching between local, private-network and HTTPS proxy URLs keeps
the selected language. If the settings request is unavailable, startup falls
back to the browser's saved settings after four seconds.

## Optional connection destinations

Operators can configure connections without changing the source code:

```sh
export PI_WEB_CONNECTIONS='[
  {"id":"local","kind":"local","url":"http://127.0.0.1:31415"},
  {"id":"private","kind":"tailscale","url":"https://computer.tailnet.example"},
  {"id":"remote","kind":"remote","name":"Remote server","url":"https://agent.example.com"}
]'
```

The example hostnames are placeholders. `id` must be unique. `kind` chooses a
translated default label and hint; optional `name` and `description` provide
operator-defined labels. Connection URLs must be origins without credentials,
query parameters, fragments or path prefixes. Public connections require HTTPS.
HTTP is accepted only for loopback, private IP addresses and Tailscale's shared
address range.

The Connections panel switches to a configured destination while retaining the
current conversation. It exchanges a random, single-use ticket for an HttpOnly
cookie at the destination; the persistent access token is not exposed to page
JavaScript. Tickets expire after one minute and are bound to the target host and
port. All destinations must reach the same running pi-web instance. Use
`PI_WEB_TOKEN` for remote access. Signing out clears the current origin's cookie.

`PI_WEB_DEFAULT_WORKSPACE` optionally pre-fills the working directory when there
are no recent locations. It is a runtime setting, not a path embedded in the UI.

An optional `-extra-host` flag adds a private listener beside the primary
loopback listener. A non-loopback listener requires authentication. If that
interface is unavailable, pi-web retries it independently so the primary server
and any separately configured reverse proxy continue working. Network tunnels,
certificates and firewall rules remain the operator's responsibility.

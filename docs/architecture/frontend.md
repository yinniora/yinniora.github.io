# Frontend Architecture

pi-web uses a single Vite-built Svelte SPA embedded into the Go binary, plus a separate self-contained static export path.

## Vite App Frontend

Browser startup: `main.js` hydrates shared settings and resets the i18n
cache before mounting. This preserves the selected language when moving between
localhost, Tailscale and reverse-proxy origins with independent localStorage caches.
Vite entry CSS is read from the manifest, linked in the live shell and served
as `text/css`. Component styles must be included alongside the JS entry.

`HubPanel.svelte` provides responsive session actions, Trash and connection
switching. `HomeMenu.svelte` uses the existing theme tokens with a desktop
popover and a mobile bottom sheet. Both direct and Trash permanent deletion
require an explicit second action in the UI. The client never reads the access
token: changing origins uses an authenticated API and a single-use pairing URL.

The home menu links to Settings › Models. The remote connection badge on the
home screen opens Settings › Connections (`ConnectionSettings.svelte`) and
returns directly to Home. The panel reads available remote routes from the
authenticated client. `navigate()` wraps route
changes in `withPageTransition()`, which uses `document.startViewTransition`
with `html[data-nav-motion=forward|back]` for push/pop page motion. It falls
back to an instant swap without View Transitions, with reduced motion, or while
the keyboard is open; the per-pane `data-route-motion` animation is skipped
while a view transition runs.

Built with **Vite + Svelte + JavaScript modules**, embedded into the Go binary.

### Build Pipeline

```txt
web/src/main.js
web/src/App.svelte
web/src/routes/*.svelte
web/src/{components,routes,index,session,settings,shared}/**/*.{svelte,js}
        │
        └──▶ vite build ──▶ web/dist/ ──▶ //go:embed
                              │
                              ▼
                         .vite/manifest.json
```

At startup, `internal/frontend/assets.go` + `web/assets_embed.go` reads `.vite/manifest.json`, validates the `src/main.js` SPA entrypoint, and registers its hashed asset route under `/static/...`. Other hashed chunks are served from the embedded `web/dist/assets/` filesystem.

## SPA Shell and Routes

The live app is hosted by `internal/ui/embedded/app.html`, rendered by `internal/ui/spa_page.go`. The shell preserves the PWA contract: viewport/no-zoom metadata, theme boot, Window Controls Overlay boot, font variables, custom themes, and service-worker registration.

Browser routes served by the SPA shell:

- `/` → `web/src/routes/SessionsPage.svelte`
- `/session?id=…` → `web/src/routes/SessionPage.svelte`
- `/schedules` → `web/src/routes/SchedulesPage.svelte`
- `/settings` → `web/src/routes/SettingsPage.svelte`

An unrecognized browser path renders `NotFoundPage.svelte`. There is **no SPA login route**: when `PI_WEB_TOKEN` is set and a request is unauthenticated, the auth middleware replies with the standalone Go-rendered token prompt (`internal/ui/auth_page.go` + `internal/ui/embedded/auth.html`) before the SPA ever loads.

API, SSE, PWA, sound, and static asset routes remain server-handled and are not intercepted by the SPA fallback.

`/schedules` is reachable from the index and from a session view, so its entry points push `{ back: <origin url> }` as history state (`backState()` in `web/src/shared/navigation.js`) and the Schedules back button returns there; a direct deep link has no state and falls back to `/`.

## Sessions Index (`/`)

`SessionsPage.svelte` owns the page shell and orchestrates Svelte components for the sessions list, session cards, command palette, home menu, new-session modal, and project management modal. The same `ProjectsModal` is also mounted by the session viewer, opened from the Manage Projects control in its header. `web/src/index/` now contains pure data/API helpers (`sessions.js`) for normalization, grouping, filtering, and API calls.

Data comes from existing APIs such as `/api/sessions`, `/api/new-session`, `/api/projects`, `/api/recent-locations`, and `/events?id=__all__`. Running-session status is pushed through the shared SSE helpers and reflected reactively in the cards/counts.

## Session Viewer (`/session?id=…`)

`SessionPage.svelte` owns the route, fetches session JSON from `/api/session?id=…`, and **orchestrates the whole viewer as Svelte components**. It creates the reactive `SessionDataModel` once, provides it via context, and installs the live session runtime context (`model`, navigator, `navigateTo`, `reconcileEntries`, content runtime) before child components mount. Live components read that explicit runtime context instead of `window.__pi*` aliases. `SessionPage`'s `onMount` runs `startSessionPageRuntime()` (bootstrap, `setupSessionUi`, content-runtime wiring, header handlers, initial nav) and `setupSessionGlobals()` (page-global glue). Annotation wiring is declarative: `SessionShell` passes the annotation config to `<AnnotationLayer>` as props (via `<RightSidebar>`) rather than an imperative `init()` up-call. There is **no `session.js` orchestrator** — see `docs/dev/templates-vs-web.md` § Current Migration State.

The message pane is rendered by Svelte components (no string-building renderer): `SessionContent` → `SessionEntry` → `ToolCall` → `ToolOutput`/`AskQuestion`, with `{@html}` used only for markdown + pre-rendered ANSI tool output. Other session UI components: `SessionTree`/`SessionSidebarProjects`/`SessionSidebarSessions`/`SessionTreeNodes`/`TreeNode`, `SessionInfoHeader`, `SessionHeader`, `RightSidebar` (+ `ArtifactPanel`, `AnnotationLayer`), `ChatComposer` (+ `ChatToolbar`/`QueuePanel`/`GitFooter`), `LiveReload`, `LoadEarlier`, `CommandMenu`, `ImageModal`, the modals (`ShortcutsModal`/`ModelUsageModal`/`ForkModal`/`LabelModal`/`DiffModal`/`ShareDialog`), `BtwPopup`, `CatGatekeeper`. The left sidebar tabs between projects, sessions in one selected project, and the active session's message outline. The Projects tab requests 20-project pages from `/api/projects?limit=20&offset=…`, pins the current project into the first page, and appends another page as the main list is scrolled. An interrupted incremental request is retried once automatically, then leaves a compact retry control at the list boundary if the connection remains unavailable. That first response also bundles the current project's first five sessions so the expanded folder does not require a second archive scan. Other folders and later session pages independently request five-session pages from `/api/sessions?project=…&limit=5&offset=…` as their nested lists are scrolled. Project rows show the shared animated running indicator when any child session is active; the initial project response supplies existing running IDs and later SSE status deltas carry the cached project path. The Sessions project card opens a searchable project switcher; selecting a project reloads only that tab's session list and leaves the viewed session unchanged. The Sessions tab requests 20-item pages through `/api/sessions?project=…&limit=…&offset=…`, and its debounced search uses the API's `q` parameter so unloaded sessions remain searchable. All three tabs end with a matching count footer; the Sessions footer also owns the previous/next page controls. The old runners/renderers have been replaced by Svelte components plus focused helpers: `web/src/session/` holds the reactive model, pure helpers, live-only helpers, and a few shared utilities:

- `data/` — payload decoding + the reactive `SessionDataModel` (`session-data.svelte.js`, the single source of truth: entries/lookups/tree/active-path/view-state, `reconcile()`)
- `tree/`, `render/`, `navigation/` — **pure** tree/format/markdown/navigation helpers consumed by the Svelte components (and the export). The message renderer is now `<SessionEntry>`/`<ToolCall>`; `render/` keeps `session-format`, `markdown`, `entry-format`, `session-entry-actions` (download/share/copy)
- `session-globals.js`, `session-content-runtime.js`, `lazy-highlight.js` — the relocated live glue (see above)
- `chat/` — **pure/shared helpers**: `chat-api` + `git-api` (fetch wrappers), `chat-selectors` (pure model/thinking helpers), `diff-api` + `diff-review` (diff modal data + review comments), `done-notifier` (shared notification/sound/push util, also used by the settings page). Live composer DOM helpers live under `web/src/components/session/chat/`, wired together by `chat-composer-runtime.js` (`runChatComposer`, mounted by `<ChatComposer>`).
- `live/` — live-only helpers used by `<LiveReload>`: `live-connection.js` (SSE connection/reconnect lifecycle), `live-events.js` (SSE/reload primitives), `live-scroll.js` (low-level scroll primitives), `live-follow.js` (`createFollowScrollController` — follow-mode decision state + follow button), `live-stats.js` (header stats), and `chat-preview.js` (streaming-preview helper, also used by `<BtwPopup>`)
- `ui/` — sidebar/search/toggle/session-ui-runner helpers used by `setupSessionUi` and `RightSidebar`
- `artifacts/`, `annotations/` — pure registries/filters/ranges + the fetch API wrappers; the panels themselves are `ArtifactPanel.svelte`/`AnnotationLayer.svelte`
- `cat-gatekeeper/` — pure timer/storage logic behind `CatGatekeeper.svelte`

The index + settings Phase 4 migration is complete: those routes are Svelte-orchestrated too, with only pure/API helpers left outside components.

Each visible final assistant reply in the live conversation or BTW shows a
copy control, the recorded model name (provider id and reply time in its
tooltip) and the actions menu on one line. The footer follows the output cards associated
with that reply. Older replies can use a preceding model change from the
displayed path. The copy action writes the reply's Markdown text and skips
internal thinking and tool blocks. The collapsed session outputs sit after
the latest turn's activity and before its final reply or error. If the turn
has no final reply, the card sits at the end of the displayed path.
User messages have their send time, a copy control and the actions menu below
the bubble. Pi's image resize notes (`[Image: original …]`) are for the model
and are hidden from the bubble and the copied text. The activity group that
collects a turn's thinking and tool calls is titled with the turn's duration
("Worked for 1m 12s") and shows the tool count as its summary. While the turn
runs the group is open so finished thinking and tool calls (each folded) stream
in above the live preview; when the turn ends it folds, leaving only the final
reply. Folding a running group is remembered in memory for that run only, and
every open group also has a collapse control at its end for long runs.

Keyboard hints are hidden on touch screens (`hover: none` or `pointer: coarse`).
Queued rows have visible Edit, Send now and Remove controls. Pending guidance
shows Edit, Move to queue and Withdraw during its five-second send window. Send
now dispatches the same draft immediately. The card closes at dispatch. The
client tracks delivery through the saved user message or native handling
acknowledgement, including after reconnecting or returning to the page. Under
Settings → Conversation, the running-send preference controls whether the
composer's single send button steers or queues while Pi is running. Turn errors
and interruptions share a status card with recovery actions and collapsible
details when available. Consecutive rejections for the same model in a turn
share one visible card. Pi web workers cancel automatic retry backoff for
provider rejections, but let Pi retry transport drops such as a reset TLS
handshake (ECONNRESET, timeouts, fetch failures), which usually succeed again.
The card can open the conversation's model picker or resend the original
prompt, including images, without modifying the current draft.

## Static / Share Export

Export/share remains separate and self-contained. `web/src/export/export-entry.js` builds `internal/ui/embedded/export/export.js`, which is inlined by `internal/ui/export.go` with vendored `marked` and `highlight.js` assets.

Export rules:

- no Go server dependency
- no live SSE/chat imports
- no `/static/assets/...` dependency
- reusable rendering helpers may be shared with the live app when they are side-effect-free

## Live Reload

The session route listens to `/events?id=<sessionId>` via `web/src/session/live/` helpers for:

- `reload` / canonical session updates
- `chat-preview` phase and streaming updates, with the worker's current preview replayed
  when the session connects or reconnects
- annotation snapshots

The index route listens to `/events?id=__all__` for `new-session`, `status-snapshot`, and `status-delta`.

Leaving a session stops its worker-status poll and aborts pending transcript
reloads. A session load has a deadline and keeps a way back to the index.
If it fails, retry remounts only that session at the current URL.
The initial transcript includes its current running status. On reconnect,
the view reconciles saved entries before showing that a previously running
turn stopped. The latest empty reply is checked against the output list
before it shows recovery actions.
Within the session a composer progress strip stays visible while Pi is working,
even before any text arrives. Streaming thought blocks can be expanded
independently. Consecutive tool-only entries use tighter rows and move message
actions to a separate menu so they do not cover the call.

## Shared Frontend Modules

- `web/src/shared/api.js` — JSON fetch helpers
- `web/src/shared/status-events.js` — shared status SSE lifecycle
- `web/src/shared/app-events.js` — named `/events` subscriptions (schedules, scratchpad,
  settings) multiplexed onto one EventSource per topic, so extra consumers do not eat
  the browser's six-connection-per-host budget
- `web/src/shared/storage.js` — localStorage helpers
- `web/src/shared/escape.js` — HTML escaping
- `web/src/shared/theme.js` — theme toggle (dark/light/nord/dracula/custom)
- `web/src/shared/version.js` — pure version formatting/changelog/fetch helpers; `VersionController.svelte` owns the update modal/status UI
- `web/src/shared/keybindings.js` — remappable keyboard-action registry (default combos for global, navigation, and composer shortcuts); `keyboard-nav.js` and the session globals consume it
- `web/src/shared/keyboard-nav.js` — vim-style j/k/gg/G navigation
- `web/src/components/shared/CommandPalette.svelte` — shared ⌘K session search palette

## Static Assets

| Asset | Source | Served From |
|-------|--------|-------------|
| Vite SPA bundle | `web/dist/assets/app-*.js` | `/static/assets/app-*.js` |
| Vite lazy chunks | `web/dist/assets/*.js` | `/static/assets/*.js` |
| Static export JS | `internal/ui/embedded/export/export.js` + vendors | inline in exported HTML |
| Theme CSS | `internal/ui/embedded/styles/theme.css` | inlined in SPA shell + export |
| Index CSS | `internal/ui/embedded/styles/index.css` | inlined in SPA shell |
| Settings CSS | `internal/ui/embedded/styles/settings.css` | inlined in SPA shell |
| Schedules CSS | `internal/ui/embedded/styles/schedules.css` | inlined in SPA shell |
| Session CSS | `internal/ui/embedded/styles/session.css` | inlined in SPA shell + export |
| Menu CSS | `internal/ui/embedded/styles/menu.css` | inlined in SPA shell |
| Palette CSS | `internal/ui/embedded/styles/palette.css` | inlined in SPA shell |
| Custom themes | `~/.pi/agent/pi-web/custom-themes.css` (optional) | `/custom-themes.css` |
| PWA manifest | `internal/ui/embedded/assets/manifest.webmanifest` | `/manifest.webmanifest` |
| Service worker | `internal/ui/embedded/assets/sw.js` | `/sw.js` |
| Icons | `internal/ui/embedded/assets/icon.svg` etc. | `/icon.svg`, `/icon-maskable.svg`, `/pi-logo.svg` |
| Sound assets | `internal/ui/embedded/assets/cat.webm` | `/cat.webm` |
| User sound assets | `~/.pi/agent/pi-web/assets/*.mp3` | `/sounds/*.mp3` |

## Theme System

The live SPA shell uses `theme.css`, `index.css`, `settings.css`, `schedules.css`, `session.css`, `menu.css`, and `palette.css` from `internal/ui/embedded/styles/`. They are inlined into the shell (there are no standalone CSS routes; only `/custom-themes.css` is served). The shell still injects the server-backed theme and font variables before the app starts so first paint matches the installed PWA theme without a flash.

## Personal client

The live client displays generated files below their reply, with inline previews and downloads next to the filename. In the activity timeline, image results appear at their recorded steps and are labeled by operation. A completed reply collects the previews above its text in a separate disclosure that opens by default. The summary groups adjacent operations while preserving their order. The full-screen viewer opens both generated files and tool images.

Tool images resolve their source only near the viewport and decode asynchronously. Folding the summary releases its thumbnail elements and cancels pending preview fetches. The timeline keeps filename references after the thumbnails move to the summary. For a partial SVG read or a file edit without a recorded snapshot, previews can use the authenticated asset endpoint and identify the workspace file as their source. SVG previews remain scriptless. Workspace file links in live Markdown use the current authenticated host connection for downloads. A missing file produces a notice within the conversation. `remote-entry.js` boots the independent DTLS client before mounting the same SPA. Its service worker streams native media and large downloads over that connection and keeps private content out of its cache. See [remote security](remote-security.md). Static exports render ordinary Markdown links.

`ProjectsModal` offers project deletion for discovered and registered folders. Its confirmation defaults to preserving files; selecting a Mac Trash move opens a second confirmation covering the entire folder and its descendants, without a typed challenge. The client supplies the existing API confirmation field only after that second click.

The live conversation groups each reply's tool calls, recorded thinking, and
intermediate commentary into one compact disclosure with a tool count and a
visible running or failed state. The final reply and generated files remain
visible. Opening a group reveals rows that can expose their underlying details.
Entry links reveal their enclosing disclosures, and unanswered tool questions
stay reachable. The toggle controller persists per-entry overrides and provides
expand/collapse-all through `ActivityControls`. Static exports keep their
existing rendering.

The progress row uses the Mac worker's active tool name and elapsed time. An
event-stream reconnect restores the timer from the worker snapshot. A shell
timeout has a distinct label on the tool row, and its output is available in
the expanded details alongside the other tools in the turn.
In the transcript, a waiting label appears before the first model chunk.
The event stream coalesces same-phase text snapshots while delivering phase
changes and completion immediately. Further chunks update the active thinking
step without rebuilding conversation activity. When the user types or composes,
preview paints run less frequently and the transient scroll follow yields to
the input. Completion still reconciles the full saved transcript.
Pending computer approval is shown directly above the composer toolbar, with
separate controls for approving the action once and declining it.
The toolbar shows the current permission mode after the server confirms it.
System appearance is the default. Both clients resolve it on appearance change
and when the page becomes active again.

`DevicePanel` lists active approvals with precise enrollment/connection times,
coarse system/browser/app labels, short key IDs and live presence. Removal uses
a second click, removes the row immediately, and rejects stale list responses.
`MacFolderPicker` browses authenticated Mac-home directory listings from either
the project or new-session modal; it never opens a phone file-upload control.
`ConnectionStatus` subscribes to the actual remote client: connection/reconnection,
initial synchronization and finite request loading (SSE excluded). P2P/Relay
comes from the selected WebRTC candidate pair. `RemoteSettings` exposes the
local-only Mac-authenticated server configuration, with separate relay credentials
and no browser-storage persistence. See [self-hosted remote setup](self-hosted-remote.md).

### Mobile workspace and media

At <=900px, `MobileHome` presents projects and ordinary conversations on the
home route. `HomeProject` independently pages each expanded folder, persists
collapse state, and provides new-conversation and project-delete controls.
Empty registered projects remain visible. Ordinary conversation creation uses a
dedicated Mac workspace (configured default or the agent workspace folder),
without asking the phone to pick a folder. The session header returns Home;
a right swipe from the left part of the transcript also returns Home. The
gesture is scoped to the transcript and leaves vertical scroll, interactive
controls and horizontally scrollable code with their native handling. Desktop
keeps the existing sidebar and home composer.
In mobile settings, a right swipe leaves the current subsection or returns
from the settings list along the same route as the header back control.
Forward and back navigation animate incoming content in opposite directions
while headers and the composer stay fixed. Sheets, dialogs and anchored menus
use short entrance and exit transitions. Closing a layer releases interaction
immediately. Motion follows the system preference, and route movement pauses
while the keyboard is open.
Session cards show a completion dot after a finished assistant reply. The dot
survives reloads and clears when the conversation is viewed in the foreground.
Read state is kept in the current browser.

`trackVisualViewport` is installed once per document. The whole mobile session,
model picker, sheets and BTW window use one height. While the keyboard is
visible, the app fits the smaller valid window or visual viewport height. The
outer document and the composer use the same height throughout the transition.
Mobile settings and editable overlays reveal focused fields in their own
scroll container, with standalone iOS document pan corrected once. The
project and new-session sheets share the keyboard-adjusted viewport and
use opaque chrome while editing.
The model sheet uses the keyboard-adjusted viewport on phones and opens beside
the composer on larger screens. The draft expands and collapses in place.
The selected Pi worker supplies the available reasoning levels. Before a worker
exists, or with an older Pi version, the composer uses model catalog metadata.
The session menu offers Pi Commands and Session Tools. The searchable
command picker inserts loaded extension commands, prompt templates and
skills into the draft. Session Tools displays native Pi statistics, starts
manual context compaction and downloads the native HTML export.
The existing worker poll carries the current session's pending Pi extension
dialogs and notifications. Native keyboard-aware sheets handle confirmation,
selection and text input. The computer approval guard still uses its
dedicated controls.
The Mac folder picker can create a child beside either the browsed or the
selected path. Creation selects the child, so the same action can be repeated
to build nested folders before registering a project or starting a session.
Editable controls use at least 16px text. Model selection and BTW opening do
not automatically focus a text field on mobile. Viewport metadata, CSS touch
behavior and WebKit zoom events lock page zoom while single-finger touch
events keep their native behavior. The mobile shell stays in document flow
with a bounded inner scroller. The unpaired connection panel is removed when
the workspace mounts.

Installed apps navigate with visible Home and Back controls and replace the
current address for reloads and deep links. Browser tabs retain normal
browser history. Sheets unmount on close and never traverse history.
Navigation clears the old view's input focus. Conversation follow-scroll
updates the transcript's scroll position. The remote connection view leaves
document flow as soon as the workspace renders. Installed iOS clients use
manual history scroll restoration. A stale full-screen pan or an unwanted
document pan while editing in the composer is corrected at the current height.

`ImageModal` handles transcript/Markdown images and gallery images/SVGs in a
native modal with an explicit close button, blank/letterbox dismissal, zoom and reset controls.
Two touch pointers pinch around their midpoint (1–4x), with single-finger panning
when enlarged. Pointer cancellation and capture release do not close the viewer.
Trackpad pinch uses a non-passive Ctrl-wheel handler. All these gestures scale
the image alone; the application's global page-zoom lock remains active.
Tapping the image or dragging a zoomed view does not dismiss it. SVG thumbnails and zoom use image resources, which have no nested navigation or script execution. Videos keep native controls,
inline playback, fullscreen through the viewer and an unsupported-format download
fallback. The authenticated asset bridge continues supporting Range requests.

The session header opens BTW with a short explanation of its independent context and shared project
files. A reply can be explicitly attached to the main composer draft; this never
automatically sends a message. Closing BTW leaves its saved conversation and
any running reply intact.

`VersionController` reads cached upstream tracking on mount, every visible minute
and on visibility resume. A new official commit produces a dismissible reminder
on both Mac and phone. Its dialog explains review and patching, links the official
comparison and allows a fresh metadata check. Tracking snapshots never expose
an install/restart action. Dismissal records only the public commit ID locally;
a different future official commit shows a new reminder.

Settings → Models is shared by desktop and mobile. `ModelSettings` groups keys
by user labels and refreshes one provider at a time. The catalog combines search
with filters for effort controls, image input and applied models. Selections
survive search and filter changes and are applied explicitly. New keys start
with the official OpenAI URL, which remains editable for other providers. The
backend uses Responses for automatic official OpenAI setup, detects other formats
from their catalog and keeps model IDs intact. Advertised effort capability and available
levels drive the conversation effort picker. A custom model can also
use `reasoning` and a `thinkingLevelMap` in Pi's model configuration when its
catalog omits those fields. Fixed-effort aliases and models with unknown capability
stay selectable with the effort picker hidden. The applied list
groups models by key label and shows the saved context and output limits
separately. Both limits can be edited on an applied model. The conversation's
context gauge uses the selected provider and model's metadata, including when
the display label differs from its ID.
Reasoning uses Pi's native registry and map semantics. Catalogs may also
describe exact levels using the OpenCode/models.dev `capabilities.reasoning`
or Anthropic's `capabilities.effort` and `capabilities.thinking` shapes.
Model discovery uses the provider's read-only catalog, and switching
reads the selected model's declared options locally. The model picker shows
the current model and available effort levels alongside the model list. Chinese
UI uses the names in OpenAI's Chinese documentation for recognized OpenAI models,
with API values as the fallback. The
toolbar opens the picker with an icon, and its accessible name follows the
worker's model and effort.

Appearance settings can follow the device's light or dark preference in real
time. Destructive controls share theme-aware colors, with solid buttons in
confirmation steps and outlined actions elsewhere.
The selected key can be removed after confirmation. This also removes its
applied models and saved API credential from the Mac's Pi configuration.
Removing one applied model clears the model's native configuration, its exact
provider override and exact references in local Pi startup settings. The key
can still be used with its other models.
Conversation history is retained. Idle workers reload after deletion, and
active replies finish with their original configuration.
Key entry uses a masked field, is cleared after save, and never uses browser
storage. The conversation picker refreshes on opening and displays provider labels.

The composer attachment menu opens file selection, the photo library, or the
camera. Supported image formats enter Pi's image input. Other files are saved
to a private host directory and referenced by path in the message. The computer
control menu shows tool registration and any provider-advertised model capability.
The server stores the computer-tool approval mode by session ID. A worker-side
Pi extension gates computer actions and routes individual requests through the
authenticated session API. Approvals expire and can be answered once.

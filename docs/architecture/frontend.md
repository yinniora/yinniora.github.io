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
- `chat-preview` streaming preview updates
- annotation snapshots

The index route listens to `/events?id=__all__` for `new-session`, `status-snapshot`, and `status-delta`.

Leaving a session stops its worker-status poll and aborts pending transcript
reloads. A session load has a deadline and keeps a way back to the index.
If it fails, retry remounts only that session at the current URL.

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

The live client adds `OutputGallery` with confined asset URLs and scriptless SVG previews, plus `personal.css` for desktop/mobile layout. The gallery requests files referenced by the session, so a new conversation does not inherit recently modified project files. `remote-entry.js` boots the independent DTLS client before mounting the same SPA. Its service worker sends native media/download requests through that authenticated channel; it does not cache private content. See [remote security](remote-security.md). Static exports remain independent.

`ProjectsModal` offers project deletion for discovered and registered folders. Its confirmation defaults to preserving files; selecting a Mac Trash move opens a second confirmation covering the entire folder and its descendants, without a typed challenge. The client supplies the existing API confirmation field only after that second click. Live thinking and tool calls use native `ActivityDisclosure` details/summary controls. The existing toggle controller persists per-entry overrides and exposes expand/collapse-all through `ActivityControls`. Static exports retain their existing markup.

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
the redundant mobile left drawer and session-creation/device shortcuts are
hidden. Desktop keeps the existing sidebar and home composer.

`trackVisualViewport` is installed once at App mount. The whole mobile session,
model picker, sheets and BTW window use the same visible-height/offset variables.
Editable controls use at least 16px text. Model selection and BTW opening do
not automatically focus a text field on mobile; page zoom is blocked by viewport metadata, touch-action and non-passive mobile
gesture guards. Only image-viewer controls scale an image, never the page. All
phone routes scroll inside a bounded root; the outer document cannot pan or
overscroll horizontally. The unpaired standalone entry installs the same guards
before mounting the connection screen. Scroll remains inside the transcript, model results or sheet body.

`ImageModal` handles transcript/Markdown images and gallery images/SVGs in a
native modal with an explicit close button, blank/letterbox dismissal, zoom and reset controls.
Two touch pointers pinch around their midpoint (1–4x), with single-finger panning
when enlarged. Pointer cancellation and capture release do not close the viewer.
Trackpad pinch uses a non-passive Ctrl-wheel handler. All these gestures scale
the image alone; the application's global page-zoom lock remains active.
Tapping the image or dragging a zoomed view does not dismiss it. SVG thumbnails and zoom use image resources, which have no nested navigation or script execution. Videos keep native controls,
inline playback, fullscreen through the viewer and an unsupported-format download
fallback. The authenticated asset bridge continues supporting Range requests.

BTW opens with a short explanation of its independent context and shared project
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
by user labels, refreshes one provider at a time, allows searching and selecting
multiple models, then explicitly applies them. Applied models have independent
remove controls and optional new-model context/output, image and thinking settings.
Key entry uses a password field, is cleared after save, and never uses browser
storage. The conversation picker refreshes on opening and displays provider labels.

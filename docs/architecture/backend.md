# Backend Architecture

## Plugins and session sharing

Settings → Plugins registers npm, HTTPS Git and local Pi packages through
the Pi CLI. It adds references to existing `SKILL.md` files and configures
Pi's native streamable HTTP and stdio MCP servers. Configuration goes into
the standard user-level Pi settings. A revision prevents stale forms from
overwriting newer values. The setup API is restricted to an authenticated
local browser; phone clients can use the plugins in their conversations.
MCP credentials and command arguments are omitted from API responses.
Pi loads resource changes on the next idle worker use.

A static share resolves one selected session and removes header filesystem
paths and system runtime context before serializing its export. The original
session JSONL stays intact. Conversations do not receive a cross-session
read capability from sharing.

## Labeled model keys and applied models

`/api/model-settings` is authenticated for the local window and approved encrypted
remote devices. GET exposes labels, API formats, sanitized endpoints, cached
available models and applied metadata, never API keys or custom headers. POST
adds or edits a labeled key, refreshes its endpoint, applies selected models, or
edits limits and removes entries in the applied list. Edits retain the provider ID and applied models. A
blank key keeps the stored credential. Switching servers requires an entered
key and explicitly configured credentials and routes are checked before the
move. Replacement clears a legacy API key from `auth.json` so Pi uses the new
escaped literal in the mode-0600 atomic `models.json` write. Revision checks
reject stale mutations and malformed/symlink configurations fail closed.
Endpoint or key edits verify the model catalog before writing. The API check
prefers Claude Messages, OpenAI Responses, and Gemini's native API for their
models. It uses per-model endpoint declarations from gateways such as New API.
Gateways with plain catalogs, including Sub2API deployments, can be checked
with bounded empty-body validation requests. These probes contain no prompts
or conversation history. Missing routes, rejected credentials, and ambiguous
responses retain the existing or advertised compatible protocol.
Profiles can recheck their endpoint from Settings to upgrade applied models.
An explicit operation URL pins the chosen protocol.

The Anthropic SDK appends `/v1/messages` to the model's runtime base. YuGo
keeps the gateway's mount prefix while removing its version suffix from
Anthropic bases. Model discovery still calls `/v1/models`. Applied models in
mixed gateways receive individual runtime bases, so OpenAI and Gemini keep
their required version paths. Full Chat Completions, Responses, Messages or
Gemini operation URLs are reduced to their corresponding runtime base.
Startup repairs existing saved routes before Pi workers load them. For any
gateway with Claude models, successful Bearer discovery combined with a
401/403 from native catalog auth enables Pi's Bearer header where no custom
policy is configured. The RPC worker suppresses the SDK's duplicate API-key
header when sending the same credential as Bearer on Anthropic requests.
Startup also recognizes Packy's documented Bearer setting for saved profiles.

Discovery supports OpenAI Chat/Responses and New API, Anthropic Messages and
Google Gemini formats, with bounded same-endpoint pagination, timeouts and
response sizes. HTTPS is required except on loopback; redirects never receive
keys. Error responses do not include upstream response bodies. Refresh reports
the catalog and route capabilities without generating a reply or applying models.
Advertised context and output limits take precedence, followed by the model's
ID in the bundled Pi catalog. Fixed-effort suffixes can use the known base ID.
If limits are still missing at discovery, known model families look them up in
Pi's public catalog. The lookup sends only the public vendor name, without model
credentials or private IDs. Unrecognized IDs with missing metadata use
conservative local limits of 128K context and 32K output. The editor accepts K
and M units and can restore known model limits. Editing updates the Pi model
and refreshes idle workers on their next use. Update the bundled limits after a
Pi upgrade by running `node scripts/update_model_limits.mjs <models.generated.js> --refresh`
and saving the result to `internal/server/model_limits.json`.

`/api/model-balances` reads New API token quota and OpenRouter key limits using
the corresponding saved credentials on the Mac. Only the balance state and
formatted amount inputs reach clients. A balance is bounded by both account and
key quotas when both are available. Currency conversion uses the gateway's
published units and exchange rate. Unlimited keys without account data are
reported separately. Lookup results are cached briefly by credential signature.

`/api/models` overlays canonical custom definitions on the Pi cache,
omits removed models and strips private headers. Worker configuration generations
reload an idle process on its next model selection; active replies remain intact.
Removing a model keeps the key, JSONL history and any running response.

## YuGo update tracking

The application uses `updater.NewTracking`: public official commit metadata is
checked after startup and every six hours. `/api/version` exposes a cached
`trackingOnly` snapshot with the integrated/latest official SHAs, comparison URL,
availability and check errors. `/api/check-update` refreshes this metadata. No
GitHub token, install callback, source merge or process restart is involved.
The upstream base is embedded from `internal/updater/upstream-base.txt` and
validated against `variant.json`. `/api/update` remains disabled for this variant.

## Browser session management and connection handover

`-extra-host` optionally serves the same HTTP handler on a private address in
addition to the primary loopback listener. Binding is retried independently,
so an unavailable Tailscale interface does not stop the loopback server or the
reverse proxy or outbound reverse tunnel. The second non-loopback listener requires auth.

`session_management.go` adds `/api/trash` (GET/POST), `/api/export-markdown`,
`/api/connections`, `/api/connect` and `/api/logout`. Trash is a SQLite visibility
marker; JSONL files remain unchanged and restoration removes the marker.
Permanent deletion is available directly or from Trash. It retires an idle
worker before removing its JSONL and session-owned queue/annotation records;
working directories are never removed. Running workers and external active
session status prevent permanent deletion. Trash mutations are serialized.

Configured connection destinations come only from `PI_WEB_CONNECTIONS`.
Origin handover uses a cryptographically random, single-use 60-second ticket bound to the target host and port;
the middleware exchanges it for an HttpOnly cookie and redirects to a clean URL.
Responses containing private app data use `Cache-Control: no-store`.

## Package Layout

```
pi-web/
├── cmd/pi-web/
│   └── main.go                 # Tiny CLI entry point; passes build version to app.Main
├── web/
│   └── assets_embed.go         # Embeds Vite build output from web/dist
├── internal/
│   ├── agentdir/
│   │   └── agentdir.go         # Resolve ~/.pi/agent dir + the paths pi-web stores under it
│   ├── app/
│   │   ├── app.go              # CLI flags, dependency wiring, HTTP mux setup
│   │   ├── network.go          # Bind host / loopback helpers
│   │   ├── tailscale.go        # Tailscale Serve detection/configuration
│   │   ├── models_cache.go     # Process-wide coalesced cache for model list
│   │   ├── browser.go          # Open the default browser at startup
│   │   ├── sounds.go           # Seed default notification sounds into the agent dir
│   │   ├── update.go           # runInstall / runRestart for self-update
│   │   └── state_file_*.go     # regular/development state files + flock helpers
│   ├── frontend/
│   │   └── assets.go           # Vite manifest parsing + static asset handlers
│   ├── ui/
│   │   ├── spa_page.go         # Live SPA shell renderer (RenderAppShell)
│   │   ├── app_script.go       # SPA Vite module URL path + script tag
│   │   ├── session_page.go     # Session page data prep (bootstrap base64 + CSS)
│   │   ├── live_page.go        # Shared live document head + theme/font providers
│   │   ├── export.go           # Static export renderer
│   │   ├── auth_page.go        # Auth/token entry page
│   │   ├── pwa.go              # PWA routes: manifest, sw.js, icons, css, cat.webm
│   │   └── embedded/     # Embedded HTML/CSS/assets (shells, styles, export/)
│   ├── auth/
│   │   └── auth.go             # Token-based HTTP middleware
│   ├── chat/
│   │   └── request.go          # Multipart chat request parser (text + images)
│   ├── chatqueue/
│   │   └── chatqueue.go        # SQLite-backed per-session chat queue (items + paused state)
│   ├── files/
│   │   └── files.go            # Bounded read-only dir listing for @mention autocomplete
│   ├── render/
│   │   ├── assets.go           # Vite manifest parsing helpers
│   │   └── json.go             # WriteJSON / WriteJSONError helpers
│   ├── git/
│   │   └── git.go              # git branch info, rename, PR URL detection
│   ├── updater/
│   │   └── updater.go          # Background version checker + changelog fetch
│   ├── rpc/
│   │   ├── client.go           # JSONL RPC command builders
│   │   ├── worker.go           # pi --mode rpc subprocess worker
│   │   ├── stream.go           # SSE chat-preview stream accumulator
│   │   ├── prompt.go           # OneShotPrompt: spawn pi for a single prompt (auto-title)
│   │   └── oneshot.go          # One-shot RPC for model enumeration
│   ├── server/
│   │   ├── server.go           # Server type, deps, SSE registry, route registration, SQLite open
│   │   ├── handlers.go         # index, session, api/session(s), new, fork/clone, rename, locations, models, custom-themes
│   │   ├── request.go          # Shared JSON body decoding + request-size caps
│   │   ├── chat.go             # Chat, set-model, set-thinking, worker-status, commands handlers
│   │   ├── chat_queue.go       # /api/chat/queue handler (list/add/delete/pause)
│   │   ├── chat_queue_drainer.go # Autonomous queue dispatcher (running → idle, 5s tick, mutation kick)
│   │   ├── new_session.go      # New-session creation logic
│   │   ├── git.go              # /api/git/info, /api/git/rename-branch handlers
│   │   ├── diff.go             # /api/git/diff, /api/diff/reviews handlers
│   │   ├── files.go            # /api/files handler + per-cwd file-walk cache
│   │   ├── settings.go         # Server-backed user settings (/api/settings) + SPA shell helpers
│   │   ├── btw.go              # btw scratch-chat registry: get/new + legacy migration (SQLite)
│   │   ├── auto_title.go       # Auto-title sessions via OneShotPrompt; guards against clobbering user names
│   │   ├── auto_title_heuristic.go # Heuristic fallback title from first user message
│   │   ├── metrics.go          # /metrics + /api/metrics + pprof registration (gopsutil sampler)
│   │   ├── scratchpad.go       # Per-project scratchpad get/save (SQLite)
│   │   ├── annotations.go      # Per-session review annotations: list/create/delete + SSE snapshot (SQLite)
│   │   ├── projects.go         # Project visibility prefs: list/toggle/register + index filtering (SQLite)
│   │   ├── sound.go            # /api/sounds + /sounds/ asset serving
│   │   ├── push.go             # PushManager: VAPID, subscribe/unsubscribe, NotifyDone, NotifyScheduleDone
│   │   ├── scheduler.go        # Cron tick loop + fireSchedule runner (creates a session, sends instructions)
│   │   ├── schedules_api.go    # /api/schedules + /api/schedule(/run|/runs) handlers
│   │   ├── update.go           # /api/version, check-update, update, restart handlers
│   │   ├── events.go           # SSE endpoint (/events)
│   │   ├── sse_format.go       # SSE event framing helper
│   │   ├── share.go            # Share handler adapter
│   │   ├── watcher.go          # fsnotify + polling file watcher
│   │   ├── status.go           # Running-status computation logic
│   │   ├── status_sweeper.go   # Periodic status revalidation
│   │   └── status_watcher.go   # fsnotify on session-status/ dir
│   ├── sessions/
│   │   ├── session.go          # Session/SessionSummary structs, ParseFile, LoadAll, CreateSessionFile, RenameSession, fork/clone
│   │   ├── title.go            # ReadTitleInputs: extract auto-title source text from a session
│   │   ├── cache.go            # Modtime-aware session cache
│   │   └── lookup.go           # Resolve session by ID
│   ├── schedules/
│   │   └── schedule.go         # Schedule/Run structs, SQLite store, cron next-fire (robfig/cron)
│   ├── share/
│   │   └── share.go            # GitHub Gist creation logic
│   └── workers/
│       └── manager.go          # ChatWorker lifecycle: create, cache, reap
```

> The embedded standalone export bundle lives at `internal/ui/embedded/export/`
> (`app/*.js` + `vendor/`), **not** at `internal/ui/export/`.

## Key Types

### `server.Server`

Central state holder. Created once at startup, lives for the process lifetime.

```go
type Server struct {
    agentDir      string          // ~/.pi/agent (respects PI_CODING_AGENT_DIR)
    sessionsDir   string          // ~/.pi/agent/sessions
    clients       []*sseClient    // active SSE connections
    clientsMu     sync.RWMutex
    fileMod       map[string]time.Time  // last seen modtime per session
    fileModMu     sync.RWMutex
    chatSender    ChatSender      // workers.Manager
    cache         *sessions.Cache // modtime-aware parse cache
    auth          *auth.Middleware
    shareRunner   shareCmdRunner  // overridable in tests
    now           func() time.Time
    renderExportSession func(s sessions.Session, theme string) string
    renderAppShell      func(w io.Writer, bootstrap string) error
    models              func(ctx context.Context) (json.RawMessage, error)
    lastKnown     map[string]struct{} // sessions currently broadcast as running
    lastKnownMu   sync.Mutex
    push          *PushManager    // web-push subscriptions + done notifications
    stopCh        chan struct{}
    stopOnce      sync.Once
    wg            sync.WaitGroup

    taskMu     sync.Mutex      // shuts out new tasks and owns taskCtx
    taskCtx    context.Context // server lifecycle context for background work
    taskCancel context.CancelFunc
    stopping   bool

    db            *sql.DB          // SQLite (~/.pi/agent/pi-web.sqlite)
    schedules     *schedules.Store // cron definitions + run history
    chatQueue     *chatqueue.Store // per-session queue items + paused state
    queueDrainer  *queueDrainer    // autonomous queue dispatcher
    updater       *updater.Checker // optional; nil disables /api/version etc.
    runInstall    func(ctx context.Context) error // optional self-update install
    runRestart    func() error                    // optional self-update restart
    updateMu      sync.Mutex      // serializes install/restart
    disableBackgroundJobs bool    // development server: no scheduler/drainer/auto-title/push

    fileWalk     *fileWalkCache  // bounded dir-listing cache for @mention autocomplete
    fileWalkOnce sync.Once

    // Metrics dashboard (see metrics.go) and auto-title bookkeeping (see
    // auto_title.go), grouped so each subsystem owns its fields + lock.
    metrics   metricsState
    autoTitle autoTitleState
}
```

`Deps` (passed to `New`) supplies everything wired from `internal/app`: the
`RenderExportSession` and `RenderAppShell` renderers, `Models`, `Cache`, `Auth`,
`ChatSender`, plus the optional `Updater`, `RunInstall`, and `RunRestart`. When
`Updater` is nil the version/update routes are not registered; when
`RunInstall`/`RunRestart` are nil the corresponding endpoints respond `503`.
`DisableBackgroundJobs` marks the internal development server: it still watches
and serves the shared data, but does not run scheduling, queue draining,
auto-titling, or push-delivery side effects.

On `New`, the server opens (and migrates) a SQLite database at
`~/.pi/agent/pi-web.sqlite` with eleven tables: `scratchpads` (per project path),
`settings` (server-backed user settings key/value), `project_prefs` (which
projects are enabled), `app_settings` (the project-filter master switch, default
off), `btw_sessions` (the btw scratch-chat registry), `annotations` (per-session
review notes keyed by session id; see `annotations.go`), `schedules` +
`schedule_runs` (definitions and firing history; see `internal/schedules`),
`review_comments` (per-session diff review notes; see `diff.go`), and
`chat_queue_items` + `chat_queue_state` (queued messages and per-session pause
state; see `internal/chatqueue`). See `projects.go`, `settings.go`, `btw.go`,
`schedules.go`, and `chat_queue.go`. The pool is capped to a single
connection (`SetMaxOpenConns(1)`) so concurrent writers queue instead of failing
with "database is locked". A `PushManager` (when configured) persists web-push
subscriptions and VAPID keys under the agent dir.

### `sessions.Session`

The domain model for a session file. The scalar fields live on `SessionSummary`
(reused for the index, where entries aren't parsed); `Session` embeds it and adds
the full header + entries.

```go
type SessionSummary struct {
    ID                 string
    SessionUUID        string
    Filename           string
    Project            string
    LastActivity       string
    Name               string
    MessageCount       int
    TokenTotal         int
    CostTotal          float64
    Model              string  // last-known model from messages or model_change
    ModelProvider      string  // provider for the last-known model
    ChatAvailable      bool
    ChatDisabledReason string
}

type Session struct {
    SessionSummary
    Header  map[string]any   // type=="session" line
    Entries []map[string]any // all JSONL lines
}
```

### `workers.Manager`

Manages `pi --mode rpc` subprocesses per session.

```go
type Manager struct {
    mu           sync.Mutex
    workers      map[string]ChatWorker  // sessionID → worker
    creating     map[string]*createCall // single-flight: coalesce concurrent creates per session
    factory      Factory                // (sessionID, sessionPath) → ChatWorker
    pendingSends map[string]int         // accepted Sends not yet acked; keeps Status from dipping to idle
    idleTTL      time.Duration          // default 10m
    reaperStop   chan struct{}
    reaperDone   chan struct{}
}
```

`Manager.Snapshot()` returns one `WorkerSnapshot` per live worker (session ID,
state, model, plus PID/uptime/idle for workers implementing the optional
`inspector` interface). The metrics dashboard consumes it — see
`docs/dev/metrics-dashboard.md`.

### `rpc.piRPCWorker`

A single `pi --mode rpc` subprocess. Communicates via JSONL on stdin/stdout.

```go
type piRPCWorker struct {
    mu                   sync.Mutex
    writeMu              sync.Mutex
    modelMu              sync.Mutex // serializes model changes with capability reads
    sessionPath          string
    startedAt            time.Time // process start; feeds metrics uptime
    cmd                  *exec.Cmd
    stdin                io.WriteCloser
    status               workers.WorkerStatus
    seq                  atomic.Uint64
    pending              map[string]chan response  // in-flight RPC calls
    currentModel         string
    currentProvider      string
    currentThinkingLevel string
    thinkingLevels       []string // Pi's cached levels for the current provider/model
    thinkingLevelsLoaded bool
    stderrBuf            *strings.Builder
    commands             []workers.SlashCommand // cached get_commands result
    commandsCached       bool
    lastActive           atomic.Int64 // unix nanos; user-initiated actions
    lastStreamActivity   atomic.Int64 // unix nanos; stream events keep worker visually running
    streamSink           StreamEventSink
    streamPreview        *streamPreviewAccumulator
}
```

The worker queries Pi's `get_available_thinking_levels` RPC after discovering
the current model or switching models. Status polling and model selection
reuse that capability data. Older Pi versions omit the list and the client
uses the model catalog. A status poll never starts a worker.

`/api/pi-session` invokes native statistics, manual compaction and HTML export
for the authorized session. HTML is generated in a restricted temporary
directory and sent as a download. The worker exposes explicit compaction
state to avoid concurrent prompts. `prompt` acknowledgments with `handled`
release a command-only run without waiting for a model turn.
Current Pi workers stay busy from prompt submission through `agent_settled`,
including native retry and recovery work. Older workers can still finish with
an `agent_end` event that lacks the `willRetry` field.
Definite connection setup failures use Pi's configured backoff and attempt
limit. Ambiguous timeouts, stream breaks and transient provider failures get at
most one automatic retry per provider step before any generation is observed.
Generation, permanent TLS errors and account errors stop automatic retry.
The failed response remains in history. A final model-network failure pauses
the remaining queue before the worker becomes idle. The session offers to
continue from saved progress or explicitly resend the original prompt.
Native compaction events update the live progress preview. The context meter
waits for a fresh provider measurement after a persisted compaction.
With auto-compaction enabled, a fresh prompt first asks the existing worker for
Pi's context estimate using the local `get_session_stats` RPC. The estimate is
combined with the incoming text and images. If the worker has no estimate, YuGo
uses the active branch's last measured provider usage and trailing messages.
Archiving an empty, zero-usage error preserves the previous measurement.
The selected model's output headroom applies after a model switch. A recent
same-model cache hit that covers at least 80% of the measured input defers the
early budget threshold while preserving output headroom. This can invoke Pi's
native compact RPC before a turn runs short of output space. A failed preflight
leaves an existing queued message available for retry.
YuGo's compaction requests ask Pi for a concise summary of the current goal,
decisions, unresolved work and evidence required to continue.
The authorized session stats endpoint includes Pi's recorded input, output,
cache reads and cache writes, plus the current context estimate when available.

The embedded worker harness uses Pi's `context_with_system` hook to replace
large, byte-identical repeated results from read-only tools with references to
earlier results. Tool calls, first results and saved transcripts retain their
full content. Plain-text Bash results of at least 3 KiB and either 48 lines or a
line over 3 KiB can use a numbered excerpt with their boundaries and diagnostics
when it saves at least 30% of the original bytes. The model can read exact lines
and columns or search for a literal in the active session context without
running the command again. The execution guidance favors bounded searches and
batched independent reads. The projection is append-stable so new results can
reuse an existing prompt prefix. Pi's native provider caching remains active. Automatic
cache-warming requests stop for credentials managed by YuGo because token-based
pricing estimates cannot account for flat per-request fees.

The worker's task checkpoint tool merges a goal, an acceptance check, constraints
and work items into Pi custom entries on the active branch. Simple work can
proceed directly. For uncertain work, use a small check to choose a path before
broad exploration. Closing an item requires evidence or a reason. Compaction
carries the acceptance check, open items, and compact closed statuses, with the
latest closed item's evidence. The checkpoint read still supplies stored older
evidence. Keeping that snapshot fixed lets later task updates append while
preserving the cached prefix. Batch checkpoint saves with useful tool calls.
When a prompted run updates its checkpoint and then
stops normally with actionable work, Pi's native settlement hook can add one
short continuation. It uses the checkpoint locally, without an evaluator model
or a duplicate user turn. Pending messages, blockers, approval and question
waits, provider errors and cancellations take precedence over this check.

Run `node scripts/measure-harness.mjs` for a repeatable comparison of request
sizes, the compacted plan, and optional Bash output retrieval. Compare planning
strategies on the same verified outcome. Sum ordinary input, cache reads and
writes, and output across planning, tools, compaction and retries. Record usage
and billing separately because providers charge different rates for each.

Model settings use Pi's `modelThinkingLevels` for per-model defaults. Known model IDs get
their official thinking levels from `internal/server/model_efforts.json`
(generated by `node scripts/update_model_efforts.mjs <models.generated.js>`),
whichever relay serves them; the relay is not probed. Configured models without
a level map are upgraded on read. Choosing a model or effort in a session saves
it as Pi's `defaultProvider`/`defaultModel` and per-model level, so new sessions
start from the last choice; a model never used starts at its official default.
A turn the provider closes with no content and no output tokens is continued
once with a recovery prompt instead of ending the task. For known
Claude IDs on the native Messages API, discovery distinguishes adaptive effort
from legacy thinking budgets. A fixed-effort alias keeps its own behavior.
Generic extension dialogs have a per-worker expiry, validate replies against
the specific pending prompt, and travel over existing authenticated session
routes. The worker checks the persisted session policy for each registered
computer-tool call. Setting Allow for session or Off resolves any unexpired
approvals already waiting. Pending approvals expire after two minutes and
are invalidated when the turn is cancelled or the worker closes. Ask each
time approves a single call by its request ID. After a decline or timeout,
the guard suppresses the same request until the user sends another message
or changes the policy. Other actions can still prompt for approval. The guard
uses a stable model instruction and returns the current decision as a tool
result so policy changes do not rewrite the cached system-prompt prefix.
This scope covers the registered `pi-computer-use` calls and recognized
computer-tool aliases. Shell, general-purpose tools and MCP tools have their
own execution policies.
The RPC worker's bundled extension supplies Pi's native 300-second timeout to
`bash` and `powershell` calls that omit one. Explicit timeout arguments pass
through unchanged. Pi cancels the shell process on timeout and returns the
captured output and error to the existing turn. This policy applies to the
shell tool calls in YuGo sessions.
`/api/project-folders` uses an account-home filesystem root for both listing
and creating a single child folder.

## HTTP Handler Map

| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/` | GET | `handleIndex` | Render SPA shell for the sessions route |
| `/session` | GET | `handleSession` | Render SPA shell for the session route |
| `/settings` | GET | `handleSettingsPage` | Render SPA shell for the settings route |
| `/api/session` | GET | `handleApiSession` | JSON session data |
| `/api/sessions` | GET | `handleApiSessions` | JSON list of session summaries |
| `/api/chat` | POST | `handleChat` | Send chat message (multipart) |
| `/api/chat/cancel` | POST | `handleCancelChat` | Abort running chat worker |
| `/api/chat/queue` | GET/POST/DELETE/PATCH | `handleChatQueue` | Saved messages, send-now acknowledgement, and pause state |
| `/api/set-model` | POST | `handleSetModel` | Change model for session |
| `/api/set-thinking-level` | POST | `handleSetThinkingLevel` | Change thinking level |
| `/api/models` | GET | `handleAvailableModels` | List available AI models |
| `/api/worker-status` | GET | `handleWorkerStatus` | Get worker state for session |
| `/api/commands` | GET | `handleCommands` | List slash commands exposed by the session worker |
| `/metrics` | GET | `handleMetricsPage` | Worker metrics dashboard (self-contained HTML) |
| `/api/metrics` | GET | `handleMetrics` | JSON snapshot: process + per-worker CPU/RSS (gopsutil); see `docs/dev/metrics-dashboard.md` |
| `/api/debug/pprof/` | GET | `pprof.Index` (+ cmdline/profile/symbol/trace) | Go runtime profiler, auth-gated (`/api`-stripped before Index) |
| `/share` | POST | `handleShare` | Create private GitHub Gist |
| `/events` | GET | `handleEvents` | SSE stream |
| `/api/new-session` | POST | `handleNewSession` | Create new session file |
| `/api/fork-session` | POST | `handleApiForkSession` | Fork a session into a new file |
| `/api/clone-session` | POST | `handleApiCloneSession` | Clone a session into a new file |
| `/api/rename-session` | POST | `handleRenameSession` | Append `session_info` rename metadata |
| `/api/label-session` | POST | `handleLabelSessionEntry` | Append a label to a session entry |
| `/api/recent-locations` | GET | `handleRecentLocations` | List known project paths |
| `/api/files` | GET | `handleApiFiles` | Bounded file listing for @mention autocomplete |
| `/api/git/info` | GET | `handleGitInfo` | Branch / dirty / PR-URL info for a project |
| `/api/git/rename-branch` | POST | `handleGitRenameBranch` | Rename the current git branch |
| `/api/git/diff` | GET | `handleGitDiff` | Uncommitted working-tree diff (tracked + untracked) for the session cwd |
| `/api/diff/reviews` | GET/POST/DELETE | `handleReviewComments` | Per-session diff review comments for the diff modal (SQLite) |
| `/api/scratchpad` | GET/POST | `handleGetScratchpad` / `handleSaveScratchpad` | Per-project scratchpad (SQLite) |
| `/api/annotations` | GET/POST/DELETE | `handleAnnotations` | Per-session review annotations; mutations broadcast an `annotations` SSE snapshot (SQLite) |
| `/api/settings` | GET/POST | `handleGetSettings` / `handleSaveSettings` | Server-backed user settings (SQLite) |
| `/api/btw` | GET | `handleGetBtw` | Resolve the btw scratch-chat session for a parent (SQLite) |
| `/api/btw/new` | POST | `handleNewBtw` | Create a new btw scratch-chat session (SQLite) |
| `/api/projects` | GET/POST | `handleApiProjects` / `handleUpdateProject` | List projects + filter state (`limit`/`offset`, optional `current` priority + `sessionLimit` bundled summaries, active session IDs per project, `filtered=1` to apply the enabled-projects allowlist with the current project always kept); enable/disable/register/remove/delete (optional native Mac Trash move with folder-name confirmation, paused schedules and recoverable conversation trash), bulk enable-all/disable-all, enable-filter/disable-filter (SQLite) |
| `/api/sounds` | GET | `handleApiSounds` | List available notification sounds |
| `/sounds/` | GET | `handleSounds` | Serve a sound asset (no auth) |
| `/custom-themes.css` | GET | `handleCustomThemes` | User custom theme CSS |
| `/api/push/vapid` | GET | `handleVapid` | VAPID public key (when push enabled) |
| `/api/push/subscribe` | POST | `handleSubscribe` | Register a web-push subscription |
| `/api/push/unsubscribe` | POST | `handleUnsubscribe` | Remove a web-push subscription |
| `/api/schedules` | GET/POST | `handleApiSchedules` | List schedules (with `nextRunAt`) / create (SQLite) |
| `/api/schedule` | GET/POST/PUT/DELETE | `handleApiSchedule` | Read/update/delete one schedule (`?id=`) |
| `/api/schedule/run` | POST | `handleApiScheduleRun` | Fire a schedule now (`?id=`); returns created `sessionId` |
| `/api/schedule/runs` | GET | `handleApiScheduleRuns` | Run log for a schedule (`?id=`) |
| `/api/version` | GET | `handleVersion` | Current/latest version (when updater set) |
| `/api/check-update` | POST | `handleCheckUpdate` | Force a version check |
| `/api/update` | POST | `handleUpdate` | Install the latest pi-web |
| `/api/restart` | POST | `handleRestart` | Restart the service onto the new binary |

PWA / static asset routes (registered outside `Server.Register`):

| Route | Source |
|-------|--------|
| `/manifest.webmanifest`, `/sw.js`, `/icon.svg`, `/icon-maskable.svg`, `/pi-logo.svg`, `/cat.webm` | `internal/ui/pwa.go` (embedded assets) |
| `/static/assets/app-*.js`, `/static/assets/...` | Embedded Vite SPA bundle and chunks (`internal/app/app.go` + `internal/frontend`) |

## Auth Flow

```
Request ──▶ auth.Wrap(handler)
                │
                ▼
      unsafe browser method?
                │
       Origin host must match
       request Host (even when
       token auth is disabled)
                │
                ▼
        token set in env?
                │
        ┌───────┴───────┐
        ▼               ▼
      yes              no
        │               │
        ▼               ▼
   extract token    pass through
   (query → Authorization: Bearer → X-Pi-Token → cookie)
        │
        ▼
   constant-time compare
        │
   ┌────┴────┐
   ▼         ▼
 match    mismatch
   │         │
   ▼         ▼
 handler   401 Unauthorized
```

The origin check protects the default tokenless localhost server from blind
cross-site browser mutations. `GET`, `HEAD`, and `OPTIONS` are unaffected.
Origin-less clients such as local CLI scripts remain compatible; a browser
request explicitly marked `Sec-Fetch-Site: cross-site` is rejected even if it
omits `Origin`. Tokenless requests also require a recognized `Host`: loopback
hosts are always accepted, and the configured bind host is added to the
allowlist. This prevents DNS rebinding from turning a same-origin attacker
hostname into access to the local server. The explicitly dangerous `--insecure`
mode preserves its documented any-host behavior.

Tailscale Serve is only configured when `PI_WEB_TOKEN` is set. Serve proxies the
tailnet to the loopback server, so allowlisting its hostname for tokenless access
would silently widen a loopback-only deployment into unauthenticated tailnet-wide
access to the agent — defeating the same non-loopback token guard enforced at
startup. When no token is set, startup skips Serve and stays loopback-only; the
discovered Tailscale hostname is added to the allowlist only alongside a token.

JSON handlers share `decodeJSONBody`, which caps request bodies at 2 MiB,
rejects multiple JSON values, and rejects an explicit media type other than
`application/json`. An omitted `Content-Type` remains valid for CLI
compatibility. Multipart chat uploads retain their separate 32 MiB total and
10 MiB-per-image limits.

## Background Work and Shutdown

Side-effecting asynchronous work started by the server—chat dispatch, worker
prewarming, scheduled runs, queue dispatch, auto-titling, and push
notifications—is registered through `startTask`. Every task receives the
server-owned context. Shutdown prevents new tasks, cancels that context, stops
the long-running watchers/drainers, waits for all accepted work, and only then
closes SQLite. The service restart trigger is intentionally detached because
it must outlive the response that initiates shutdown.

## SSE Broadcasting

The server maintains a slice of `sseClient` structs. Each client subscribes to a `sessID`:

- `__all__` — index page subscribes here; receives `new-session`, `status-snapshot`, `status-delta`
- Specific session ID — session page subscribes here; receives `reload` when the file changes, `chat-preview` during streaming, and `annotations` (a full annotation snapshot) whenever a note is created/deleted for that session

For a live Pi worker, `chat-preview` starts with its session's current phase and
buffered provider-supplied response and thinking text. The worker holds that
transient snapshot in memory, replacing it with a phase-only snapshot when an
assistant message commits and discarding it when the run ends. Revisions keep a
reconnect snapshot ahead of older events that may already be queued.

Chat previews use a separate one-slot queue for each subscriber. A newer
cumulative snapshot replaces the pending one, and a skipped commit still
triggers a transcript reload. A slow subscriber cannot block the Pi worker.
Other events use a 16-slot queue. Duplicate `reload` and `new-session` events are
coalesced per-client while pending.

## Running-Status Computation

Three signals are OR'd together to determine if a session is "running":

1. **session-status file** (`~/.pi/agent/session-status/<id>`): written by the terminal pi process
2. **In-process chat worker**: `chatSender.Status(id).State == running`
3. **Recent file activity**: JSONL file modtime within 800 ms

Status changes are broadcast as SSE `status-delta` events to `__all__` subscribers. A 1-second sweeper periodically revalidates all known running sessions to clean up stale states.

## Personal remote access

`internal/relay` carries bounded HTTP over standard WebRTC DTLS. `devices.go` owns native-approved single-use tickets, public-key whitelisting and immediate revocation. `assets.go` confines media access with `os.OpenRoot` and supports byte ranges. Remote requests never receive the global Pi token. See [remote security](remote-security.md).

Project deletion retires idle RPC workers before updating trash/prefs/schedules in one SQLite transaction. Running jobs reject deletion. Optional filesystem moves use the configured native `PI_WEB_PROJECT_TRASH_HELPER`; protected runtime/configuration paths and roots are refused. Restore releases the worker retirement marker. Session creation and timer scheduling coordinate through the session-management lock.

### Optional conversation file cleanup

`GET /api/session-files?id=...` is authenticated and never uses recent-mtime
workspace discovery as deletion authority. On macOS it lists only regular,
non-symlink files born after the session began, with bytes matching a successful
structured `write` and no path reference from another session (including Trash).
Ambiguous shell outputs, shared/edited files, hardlinks and unsupported platforms
are preserved. Verification is bounded to 16 MiB per file and 2,000 sessions.

`POST /api/trash` optionally accepts selected `{path,digest}` files and
`confirmFiles:true`, for either recoverable conversation Trash or permanent
conversation deletion. File deletion is permanent and confirmed separately in
the UI; restoring the conversation does not restore deleted files. The server
rechecks ownership/digests, retires idle workers, atomically stages only the
selected files inside `os.Root`, rechecks inode identity, then commits metadata
before removing staged files. Errors before commit restore staged files. It
never recursively deletes a project directory or accepts unchecked arbitrary
paths. File cleanup is off by default.

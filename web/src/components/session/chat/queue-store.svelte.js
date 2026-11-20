// Reactive state behind the docked queue panel above the composer.
//
// Two kinds of items share one ordered list:
//
//   - queued — pending messages owned by the *server* (chat_queue table). The
//     autonomous drainer runs them when the worker becomes idle, even when no
//     browser is connected. We hydrate from GET /api/chat/queue on mount and
//     re-fetch when an SSE 'queue' event lands so other tabs stay in sync.
//   - steer  — in-flight prompts the worker is folding into the active run.
//     These belong to a specific stream that has no meaning after the page
//     goes away, so they live only in browser memory.
//
// All queued-side mutations go through the QueueApi (queue-api.js); the
// runtime glue (steer-queue.js) wraps these for the user-facing actions
// (enqueue, sendNow, edit, resume, remove).

export class QueueStore {
  items = $state([]);
  paused = $state(false);
  focusIndex = $state(-1);

  actions = {
    sendNow: () => {},
    edit: () => {},
    editSteer: () => {},
    withdrawSteer: () => {},
    queueSteer: () => {},
    resume: () => {},
  };

  #api = null;
  #steerSeq = 0;
  #pendingRefresh = false;
  #refreshAgain = false;

  /** @param {{ api?: { list, add, remove, setPaused }|null }} [opts] */
  constructor({ api = null } = {}) {
    this.#api = api;
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  get count() {
    return this.items.length;
  }

  get queuedCount() {
    return this.items.filter((item) => item.kind === 'queued').length;
  }

  get steerCount() {
    return this.items.filter((item) => item.kind === 'steer').length;
  }

  get persistsLocally() {
    // The panel header uses this to render the "saved on server" hint when
    // there's a real API backing the store.
    return !!this.#api;
  }

  // ── Server-backed loading ─────────────────────────────────────────────────

  /** Pull the latest snapshot from the server, replacing the queued portion
   *  of `items` and the paused flag. Steers (browser-only) are preserved.
   *  Concurrent callers share the in-flight Promise so they all see the same
   *  resolved state without firing duplicate GETs. */
  refresh = () => {
    if (!this.#api) return Promise.resolve();
    if (this.#pendingRefresh) {
      this.#refreshAgain = true;
      return this.#pendingRefresh;
    }
    this.#pendingRefresh = (async () => {
      try {
        do {
          this.#refreshAgain = false;
          try {
            const snapshot = await this.#api.list();
            this.#mergeServerSnapshot(snapshot);
          } catch {
            /* The next notification can retry a missed snapshot. */
          }
        } while (this.#refreshAgain);
      } finally {
        this.#pendingRefresh = false;
      }
    })();
    return this.#pendingRefresh;
  };

  #mergeServerSnapshot(snapshot) {
    const serverItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const steers = this.items.filter((item) => item.kind === 'steer');
    const queued = serverItems.map((entry) => ({
      id: `q-${entry.position}`,
      kind: 'queued',
      position: entry.position,
      text: String(entry.message ?? ''),
      displayText: String(entry.displayText ?? entry.message ?? ''),
      files: [],
    }));
    this.items = [...queued, ...steers];
    this.paused = !!snapshot?.paused;
    this.#clampFocus();
  }

  // ── Mutations (queued items go through the API) ───────────────────────────

  /** Append a server-side queued item. Returns the canonical item or null on
   *  failure. We do a fresh list() after POST instead of awaiting `refresh()`
   *  — refresh's in-flight-promise coalescing would otherwise hand us back a
   *  snapshot taken *before* our insert if another refresh was already
   *  in-flight (very easy to hit during rapid double-queue clicks). */
  enqueueQueued = async ({ message, displayText } = {}) => {
    if (!this.#api) return null;
    try {
      const item = await this.#api.add(message, displayText);
      const snapshot = await this.#api.list();
      this.#mergeServerSnapshot(snapshot);
      return {
        id: `q-${item.position}`,
        kind: 'queued',
        position: item.position,
        text: String(item.message ?? message ?? ''),
        displayText: String(item.displayText ?? displayText ?? message ?? ''),
      };
    } catch {
      return null;
    }
  };

  /** Push a transient steer chip (browser-only, never persisted). */
  pushSteer = (item) => {
    const id = `s-${++this.#steerSeq}-${Date.now().toString(36)}`;
    this.items.push({
      id,
      kind: 'steer',
      text: String(item.text ?? ''),
      displayText: String(item.displayText ?? item.text ?? ''),
      editable: !!item.detail?.cancelBeforeSend,
      detail: item.detail,
    });
    this.#clampFocus();
    return id;
  };

  clearSteers = () => {
    if (this.steerCount === 0) return;
    this.items = this.items.filter((item) => item.kind !== 'steer' || item.editable);
    this.#clampFocus();
  };

  /** Remove an item by id. Queued items are also removed on the server. */
  removeById = async (id) => {
    const item = this.items.find((item) => item.id === id);
    if (!item) return false;
    if (item.kind === 'queued' && this.#api && Number.isInteger(item.position)) {
      try {
        await this.#api.remove(item.position);
      } catch {
        await this.refresh();
        return false;
      }
    }
    this.takeLocalById(id);
    return true;
  };

  /** Remove a local copy after the server acknowledges a queue mutation. */
  takeLocalById = (id) => {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const item = this.items[idx];
    const next = this.items.slice();
    next.splice(idx, 1);
    this.items = next;
    if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
    else if (idx < this.focusIndex) this.focusIndex -= 1;
    return item;
  };

  setPaused = async (value) => {
    const next = !!value;
    if (this.paused === next) return;
    this.paused = next;
    if (this.#api) {
      try {
        await this.#api.setPaused(next);
      } catch {
        this.paused = !next;
        await this.refresh();
      }
    }
  };

  togglePaused = () => this.setPaused(!this.paused);

  setFocusIndex = (index) => {
    if (!Number.isInteger(index)) return;
    if (index < 0 || this.items.length === 0) {
      this.focusIndex = -1;
      return;
    }
    this.focusIndex = Math.min(this.items.length - 1, index);
  };

  focusUp = () => {
    if (this.items.length === 0) return;
    if (this.focusIndex <= 0) this.focusIndex = this.items.length - 1;
    else this.focusIndex -= 1;
  };

  focusDown = () => {
    if (this.items.length === 0) return;
    if (this.focusIndex < 0 || this.focusIndex >= this.items.length - 1) this.focusIndex = 0;
    else this.focusIndex += 1;
  };

  focusedItem = () => {
    if (this.focusIndex < 0 || this.focusIndex >= this.items.length) return null;
    return this.items[this.focusIndex];
  };

  #clampFocus() {
    if (this.items.length === 0) {
      this.focusIndex = -1;
      return;
    }
    if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
  }
}

// In-memory prefetch cache for /api/session payloads, used by SessionCard hover
// to start the request before the route actually mounts. loadSessionPageState
// consumes the in-flight promise instead of issuing a fresh fetch when present.
//
import { cachedSession, sessionWindowURL } from '../session/data/session-sync.js';

const inflight = new Map();
const MAX_ENTRIES = 4;

export function prefetchSession(id, { fetchImpl = fetch } = {}) {
  if (!id || inflight.has(id) || cachedSession(id)) return;
  if (inflight.size >= MAX_ENTRIES) {
    const oldest = inflight.keys().next().value;
    if (oldest) {
      inflight.get(oldest)?.controller.abort();
      inflight.delete(oldest);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const entry = { controller, promise: null };
  const promise = fetchImpl(sessionWindowURL(id), {
    headers: { Accept: 'application/json' },
    priority: 'low',
    signal: controller.signal,
  })
    .then((resp) => {
      if (!resp.ok) {
        throw new Error(resp.status === 404 ? 'not found' : 'load failed');
      }
      return resp.json();
    })
    .catch((err) => {
      if (inflight.get(id) === entry) inflight.delete(id);
      throw err;
    })
    .finally(() => clearTimeout(timer));
  // Swallow uncaught-rejection warnings: consumeSessionPrefetch handlers add a
  // proper catcher when they read this back.
  promise.catch(() => {});
  entry.promise = promise;
  inflight.set(id, entry);
}

export function consumeSessionPrefetch(id) {
  if (!id) return null;
  const entry = inflight.get(id);
  if (!entry) return null;
  inflight.delete(id);
  return entry.promise;
}

export function resetSessionPrefetch() {
  for (const { controller } of inflight.values()) controller.abort();
  inflight.clear();
}

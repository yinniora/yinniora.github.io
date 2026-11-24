import {
  clearWorkspaceCache,
  readWorkspaceCache,
  writeWorkspaceCache,
} from '../../shared/workspace-cache.js';

export function sessionWindowURL(id, { full = false, model, range } = {}) {
  const query = new URLSearchParams({ id, window: '1' });
  if (full) query.set('full', '1');
  if (model?.revision) {
    query.set('known', model.total);
    query.set('revision', model.revision);
  }
  if (range) {
    query.set('from', range.from);
    query.set('count', range.count);
  } else if (!model && !full) {
    // Keep cold loads bounded when an older host serves the current phone app.
    query.set('paginate', '1');
  }
  return `/api/session?${query}`;
}

export function isSessionRoute(id, location = window.location) {
  return location.pathname === '/session' && new URLSearchParams(location.search).get('id') === id;
}

export function cachedSession(id) {
  return readWorkspaceCache(`session:${id}`);
}

export function cacheSession(id, data) {
  if (!data?.revision || !Number.isInteger(data.recentBytes) || !Array.isArray(data.entries))
    return;
  const start = data.from || 0;
  const from = Math.max(start, data.recentFrom || 0);
  const entries = data.entries.slice(from - start);
  if (from + entries.length !== data.total) return;
  writeWorkspaceCache(`session:${id}`, { ...data, from, entries }, 1024 + data.recentBytes * 2);
}

export async function fetchSessionUpdate(sessionId, { model, fetchImpl, signal, onUnavailable }) {
  const full = Boolean(model.urlLeafId || model.urlTargetId);
  const response = await fetchImpl(sessionWindowURL(sessionId, { full, model }), {
    signal,
    priority: 'low',
    headers: { Accept: 'application/json' },
  });
  if (signal.aborted) return null;
  if ([401, 403, 404, 410].includes(response.status)) {
    clearWorkspaceCache(`session:${sessionId}`);
    onUnavailable(response.status);
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  if (signal.aborted || (data.sessionId && data.sessionId !== sessionId)) return null;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!data.delta) return { ...data, entries };
  if (data.from !== model.total || data.total !== data.from + entries.length) return null;
  return {
    ...data,
    from: model.from,
    entries: entries.length ? [...model.entries, ...entries] : model.entries,
    unchanged: entries.length === 0,
  };
}

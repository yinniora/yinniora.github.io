import { SvelteMap } from 'svelte/reactivity';

const STORAGE_KEY = 'yugo:session-completions:v1';
let state;

export function initializeSessionCompletions() {
  if (state) return state;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Number.isFinite(saved?.since) && Array.isArray(saved.seen)) {
      state = { since: saved.since, seen: new SvelteMap(saved.seen) };
      return state;
    }
  } catch {}
  state = { since: Date.now(), seen: new SvelteMap() };
  persist();
  return state;
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ since: state.since, seen: [...state.seen] }),
    );
  } catch {}
}

export function hasUnseenCompletion(session) {
  const { since, seen } = initializeSessionCompletions();
  return Date.parse(session.lastCompletedAt) > Math.max(since, seen.get(session.id) || 0);
}

export function markSessionCompletionSeen(id, entries) {
  const latest = entries.findLast(
    (entry) =>
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      ['', 'stop'].includes(entry.message.stopReason || '') &&
      entry.timestamp,
  );
  markCompletionSeen(id, latest?.timestamp);
}

export function markCompletionSeen(id, completedAt) {
  const timestamp = Date.parse(completedAt);
  const { since, seen } = initializeSessionCompletions();
  if (!(timestamp > Math.max(since, seen.get(id) || 0))) return;
  seen.delete(id);
  seen.set(id, timestamp);
  if (seen.size > 512) seen.delete(seen.keys().next().value);
  persist();
}

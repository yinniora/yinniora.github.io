const records = new Map();
const MAX_AGE = 3 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 24;
const PROJECT_PREFIX = 'home:project:';
let bytes = 0;

function authorized() {
  const client = globalThis.window?.__PI_REMOTE_CLIENT__;
  return !client || (client.authorized && !client.blocked);
}

function remove(key) {
  const item = records.get(key);
  if (!item) return;
  bytes -= item.size;
  records.delete(key);
}

export function clearWorkspaceCache(prefix = '') {
  for (const key of records.keys()) if (key.startsWith(prefix)) remove(key);
}

export function readWorkspaceCache(key) {
  if (!authorized()) return null;
  const item = records.get(key);
  if (!item) return null;
  if (item.until <= Date.now()) {
    remove(key);
    return null;
  }
  records.delete(key);
  records.set(key, item);
  return item.value;
}

export function writeWorkspaceCache(key, value, size) {
  if (!authorized()) return;
  remove(key);
  size ??= JSON.stringify(value).length * 2;
  if (!Number.isFinite(size) || size < 0 || size > MAX_BYTES) return;
  while (records.size >= MAX_RECORDS || bytes + size > MAX_BYTES) {
    // A home screen with many expanded folders must keep the project index
    // and recently opened transcripts available for the next route change.
    const oldestProject = [...records.keys()].find((name) => name.startsWith(PROJECT_PREFIX));
    if (!oldestProject && key.startsWith(PROJECT_PREFIX)) return;
    remove(oldestProject || records.keys().next().value);
  }
  records.set(key, { value, size, until: Date.now() + MAX_AGE });
  bytes += size;
}

import { collectArtifacts } from './artifact-registry.js';

export function assetUrl(sessionId, path, inline = false) {
  const query = new URLSearchParams({ id: sessionId, path });
  if (inline) query.set('inline', '1');
  return `/api/asset?${query}`;
}

function workspacePathKey(path, cwd) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
  if (windows) {
    path = path.replaceAll('\\', '/');
    cwd = cwd.replaceAll('\\', '/');
  }
  const absolute = path.startsWith('/') || (windows && /^[a-z]:\//i.test(path));
  const parts = [];
  for (const part of (absolute ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function collectOutputs(entries, assets = [], cwd = '', sessionId = '') {
  const pathEntries = Array.isArray(entries) ? entries : [];
  const files = collectArtifacts(pathEntries)
    .filter((artifact) => artifact.filePath || artifact.kind === 'preview')
    .map((artifact) => ({
      ...artifact,
      kind: artifact.previewType || 'file',
      name: artifact.title,
    }));
  const filesByPath = new Map(
    files
      .filter((file) => file.filePath)
      .map((file) => [workspacePathKey(file.filePath, cwd), file]),
  );
  const references = new Map();
  for (const entry of pathEntries) {
    const message = entry?.type === 'message' && entry.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'toolCall') continue;
      const path = block.arguments?.path || block.arguments?.file_path;
      if (typeof path === 'string' && path) references.set(workspacePathKey(path, cwd), entry.id);
    }
  }
  for (const asset of assets) {
    const fullPath = `${cwd.replace(/\/$/, '')}/${asset.path}`;
    const key = workspacePathKey(asset.path, cwd);
    const existing = filesByPath.get(key);
    const href = assetUrl(sessionId, asset.path);
    if (existing) {
      existing.href = href;
      existing.size = asset.size;
      existing.mime = asset.mime;
      if (['image', 'video', 'audio', 'pdf'].includes(asset.kind)) {
        existing.kind = asset.kind;
        existing.previewUrl = assetUrl(sessionId, asset.path, true);
      }
    } else {
      files.push({
        ...asset,
        id: `workspace:${asset.path}`,
        title: asset.name,
        filePath: fullPath,
        entryId: references.get(key),
        href,
        previewUrl: assetUrl(sessionId, asset.path, true),
      });
    }
  }
  return files;
}

export function groupOutputsByReply(entries, outputs) {
  const replyByEntry = new Map();
  let anchorId = null;
  // Walk back from each reply to associate it with the tool calls that led to it.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { entry, reply } = entries[index];
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user') anchorId = null;
    if (entry.message?.role !== 'assistant') continue;
    if (reply || !anchorId) anchorId = entry.id;
    replyByEntry.set(entry.id, anchorId);
  }

  const byEntry = new Map();
  const unassigned = [];
  for (const output of outputs) {
    const id = replyByEntry.get(output.entryId);
    if (!id) {
      unassigned.push(output);
      continue;
    }
    if (!byEntry.has(id)) byEntry.set(id, []);
    byEntry.get(id).push(output);
  }
  return { byEntry, unassigned };
}

export function svgPreviewURL(content) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(String(content).toWellFormed());
}

// HTML opens on request in a sandboxed iframe with an opaque origin.
export function outputDocument(content) {
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${content || ''}</body></html>`;
}

export function formatAssetSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import { marked } from 'marked';
import { collectArtifacts } from './artifact-registry.js';

export function assetUrl(sessionId, path, inline = false) {
  const query = new URLSearchParams({ id: sessionId, path });
  if (inline) query.set('inline', '1');
  return `/api/asset?${query}`;
}

function relativeOutputPath(path, cwd) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
  if (windows) {
    path = path.replaceAll('\\', '/');
    cwd = cwd.replaceAll('\\', '/');
  }
  if (!path || /[\\\p{Cc}]/u.test(path) || path.split('/').includes('..')) return '';
  const absolute = path.startsWith('/') || (windows && /^[a-z]:\//i.test(path));
  if (absolute) {
    const root = cwd.replace(/\/+$/, '') + '/';
    const withinRoot = windows
      ? path.toLowerCase().startsWith(root.toLowerCase())
      : path.startsWith(root);
    if (!cwd || !withinRoot) return '';
    path = path.slice(root.length);
  }
  const parts = path.split('/').filter((part) => part && part !== '.');
  return parts.some((part) => part.startsWith('.')) ? '' : parts.join('/');
}

// Relative file destinations in a reply refer to the session workspace.
// An empty path identifies an unavailable local file without a browser URL.
export function localOutputLink(href, cwd) {
  const fileScheme = /^(file|sandbox):/i.test(href);
  const windowsPath = /^[a-z]:[\\/]/i.test(href);
  if (!fileScheme && !windowsPath && /^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i.test(href)) return null;
  const rawPath = href.split(/[?#]/, 1)[0];
  let name;
  try {
    if (/^file:/i.test(href)) {
      const url = new URL(rawPath);
      if (url.hostname || url.username || url.password) return { path: '', title: '' };
      name = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(name)) name = name.slice(1);
    } else {
      name = decodeURIComponent(rawPath.replace(/^sandbox:/i, ''));
    }
  } catch {
    return fileScheme || /\.[a-z\d]{1,16}$/i.test(rawPath) ? { path: '', title: '' } : null;
  }
  if (
    !fileScheme &&
    !windowsPath &&
    (!/\.[a-z\d][a-z\d_-]{0,15}$/i.test(name) ||
      /^\/?(?:api|assets|sounds)\//.test(name) ||
      /^\/?index\.html$/i.test(name))
  )
    return null;
  return {
    path: name.startsWith('~/') ? '' : relativeOutputPath(name, cwd),
    title: name.split(/[\\/]/).at(-1),
  };
}

export function sessionOutputReferences(entries, cwd) {
  const written = new Map();
  const linked = new Map();
  const results = new Map();
  for (const entry of entries) {
    const message = entry?.type === 'message' && entry.message;
    if (message?.role === 'toolResult') results.set(message.toolCallId, message.isError !== true);
  }
  for (const entry of entries) {
    const message = entry?.type === 'message' && entry.message;
    if (message?.role !== 'assistant') continue;
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content || [];
    for (const block of blocks) {
      if (
        block?.type === 'toolCall' &&
        ['write', 'edit'].includes(block.name) &&
        results.get(block.id)
      ) {
        const path = block.arguments?.path || block.arguments?.file_path;
        if (typeof path === 'string') {
          const relative = relativeOutputPath(path, cwd);
          if (relative) written.set(relative, entry.id);
        }
      }
      if (block?.type !== 'text' || !block.text?.includes(']')) continue;
      marked.walkTokens(marked.lexer(block.text), (token) => {
        if (token.type !== 'link') return;
        const link = localOutputLink(token.href.trim(), cwd);
        if (link?.path && !linked.has(link.path)) linked.set(link.path, entry.id);
      });
    }
  }
  return { written, linked };
}

export function collectOutputs(
  entries,
  assets = [],
  cwd = '',
  sessionId = '',
  references = sessionOutputReferences(entries || [], cwd),
) {
  const pathEntries = Array.isArray(entries) ? entries : [];
  const files = collectArtifacts(pathEntries, { confirmedWrites: true })
    .filter((artifact) => artifact.filePath || artifact.kind === 'preview')
    .map((artifact) => ({
      ...artifact,
      kind: artifact.previewType || 'file',
      name: artifact.title,
    }));
  const filesByPath = new Map(
    files
      .filter((file) => file.filePath)
      .map((file) => [relativeOutputPath(file.filePath, cwd), file])
      .filter(([path]) => path),
  );
  for (const asset of assets) {
    const fullPath = `${cwd.replace(/\/$/, '')}/${asset.path}`;
    const existing = filesByPath.get(asset.path);
    const entryId = references.written.get(asset.path) || references.linked.get(asset.path);
    if (!existing && !entryId) continue;
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
        entryId,
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
    const { entry, reply, repeatedError } = entries[index];
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user') anchorId = null;
    if (entry.message?.role !== 'assistant') continue;
    if (!repeatedError && (reply || !anchorId)) anchorId = entry.id;
    replyByEntry.set(entry.id, anchorId);
  }

  // An output is anchored to the tool call that wrote it, so its entryId can
  // point at a toolResult or any other entry in the turn. Walk forward and give
  // every entry the reply anchor it belongs to; without this only assistant
  // entryIds resolve and everything else piles up at the end of the transcript.
  let currentAnchor = null;
  for (const { entry } of entries) {
    if (
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      replyByEntry.has(entry.id)
    )
      currentAnchor = replyByEntry.get(entry.id) || currentAnchor;
    if (!currentAnchor) continue;
    if (!replyByEntry.has(entry.id)) replyByEntry.set(entry.id, currentAnchor);
  }

  const byEntry = new Map();
  const unassigned = [];
  for (const output of outputs) {
    const id = replyByEntry.get(output.entryId);
    if (!id) {
      // Files discovered from the assets API carry no entryId at all; anchor
      // them to the newest reply so they scroll with the turn that produced
      // them instead of sticking to the bottom of the session.
      const fallback = currentAnchor;
      if (!fallback) {
        unassigned.push(output);
        continue;
      }
      if (!byEntry.has(fallback)) byEntry.set(fallback, []);
      byEntry.get(fallback).push(output);
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

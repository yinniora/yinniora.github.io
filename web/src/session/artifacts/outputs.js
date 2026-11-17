import { collectArtifacts } from './artifact-registry.js';

export function assetUrl(sessionId, path, inline = false) {
  const query = new URLSearchParams({ id: sessionId, path });
  if (inline) query.set('inline', '1');
  return `/api/asset?${query}`;
}

export function collectOutputs(entries, assets = [], cwd = '', sessionId = '') {
  const files = collectArtifacts(Array.isArray(entries) ? entries : [])
    .filter((artifact) => artifact.filePath || artifact.kind === 'preview')
    .map((artifact) => ({
      ...artifact,
      kind: artifact.previewType || 'file',
      name: artifact.title,
    }));
  for (const asset of assets) {
    const fullPath = `${cwd.replace(/\/$/, '')}/${asset.path}`;
    const existing = files.find(
      (file) => file.filePath === fullPath || file.filePath === asset.path,
    );
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
        href,
        previewUrl: assetUrl(sessionId, asset.path, true),
      });
    }
  }
  return files;
}

// SVG runs without script permission. HTML is click-to-run in an opaque origin.
export function outputDocument(content, kind = 'svg') {
  const scripts = kind === 'html' ? " script-src 'unsafe-inline';" : '';
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;${scripts}`;
  const fit =
    kind === 'svg'
      ? '<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}body>svg{display:block;width:100%;height:100vh}</style>'
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${fit}</head><body>${content || ''}</body></html>`;
}

export function formatAssetSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

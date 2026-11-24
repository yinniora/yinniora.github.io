import { assetUrl, relativeOutputPath, svgPreviewURL } from './outputs.js';
import { toolKind } from '../render/conversation-activity.js';

const imageFile = /\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;
const imageMime = /^image\/(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg\+xml|tiff|webp)$/i;
const maxSvgBytes = 2 * 1024 * 1024;

function imageAction(name) {
  const plain = String(name || '')
    .toLowerCase()
    .split('__')
    .at(-1);
  const kind = toolKind(plain);
  if (kind === 'read' || /^(read|view|open|inspect|preview)_image$/.test(plain)) return 'view';
  if (
    (kind === 'edit' && plain !== 'write' && plain !== 'create_file') ||
    /^(edit|resize|crop|rotate|convert)_image$|^image_edit$/.test(plain)
  )
    return 'edit';
  return 'other';
}

function readSvgSnapshot(blocks) {
  const contents = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const start = contents.search(/<svg(?=[\s/>])/i);
  if (start < 0) return '';
  const svg = contents.slice(start);
  // A partial Pi read ends with a continuation notice. Only a complete SVG
  // is a snapshot of the exact file the tool saw.
  return /(?:<\/svg\s*>|^<svg\b[^>]*\/>)$/i.test(svg) && svg.length <= maxSvgBytes ? svg : '';
}

export function collectToolImagePreviews(entries, cwd, sessionId) {
  const calls = new Map();
  const byResult = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'message') continue;
    const { message } = entry;
    if (!Array.isArray(message?.content)) continue;
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block?.type === 'toolCall') calls.set(block.id, block);
      }
      continue;
    }
    if (message.role !== 'toolResult') continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const action = imageAction(call.name);
    const argument = call.arguments?.path || call.arguments?.file_path;
    const path = typeof argument === 'string' && imageFile.test(argument) ? argument : '';
    const title = path.split(/[\\/]/).at(-1);
    const images = [];
    for (const [index, block] of message.content.entries()) {
      if (block?.type === 'image' && typeof block.data === 'string' && block.data) {
        images.push({ id: `${entry.id}:${index}`, title, embedded: block });
      }
    }
    if (!images.length && !message.isError && path && (action === 'view' || action === 'edit')) {
      const relative = relativeOutputPath(path, cwd);
      const svg = /\.svg$/i.test(path);
      images.push({
        id: `${entry.id}:file`,
        title,
        svg,
        svgBlocks: svg && action === 'view' ? message.content : null,
        asset: relative && sessionId ? assetUrl(sessionId, relative, !svg) : '',
      });
    }
    if (images.length) byResult.set(entry.id, { action, tool: call.name, images });
  }
  return byResult;
}

export async function resolveToolImage(image, signal, workspacePreviews) {
  if (image.embedded) {
    const mime = image.embedded.mimeType || 'image/png';
    return imageMime.test(mime) ? { url: `data:${mime};base64,${image.embedded.data}` } : null;
  }
  const snapshot = image.svgBlocks && readSvgSnapshot(image.svgBlocks);
  if (snapshot) return { url: svgPreviewURL(snapshot) };
  if (!image.asset) return null;
  if (!image.svg) return { url: image.asset, workspace: true };

  const key = image.id + image.asset;
  const cached = workspacePreviews.get(key);
  if (cached) return cached;
  const response = await fetch(image.asset, { signal, priority: 'low' });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('image/svg+xml') ||
    Number(response.headers.get('content-length')) > maxSvgBytes
  ) {
    await response.body?.cancel();
    return null;
  }
  const svg = await response.text();
  if (signal.aborted || svg.length > maxSvgBytes) return null;
  const preview = { url: svgPreviewURL(svg), workspace: true };
  // Retain small previews when a result moves from the activity to the reply.
  if (preview.url.length <= 256 * 1024) {
    if (workspacePreviews.size >= 16)
      workspacePreviews.delete(workspacePreviews.keys().next().value);
    workspacePreviews.set(key, preview);
  }
  return preview;
}

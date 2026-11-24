import { assetUrl, readPreviewText, relativeOutputPath, svgPreviewURL } from './outputs.js';
import { toolKind } from '../render/conversation-activity.js';

const imageFile = /\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;
const imageMime = /^image\/(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg\+xml|tiff|webp)$/i;
const maxSvgBytes = 2 * 1024 * 1024;

function fileAction(name) {
  const plain = String(name || '')
    .toLowerCase()
    .split('__')
    .at(-1);
  const kind = toolKind(plain);
  if (kind === 'read' || /^(read|view|open|inspect|preview)_image$/.test(plain)) return 'view';
  if (plain === 'write' || plain === 'create_file') return 'write';
  if (kind === 'edit' || /^(edit|resize|crop|rotate|convert)_image$|^image_edit$/.test(plain))
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

function filePreviewKind(path) {
  if (/\.(mp4|mov|m4v|webm)$/i.test(path)) return 'video';
  if (/\.(mp3|m4a|ogg|wav)$/i.test(path)) return 'audio';
  if (/\.pdf$/i.test(path)) return 'pdf';
  return 'file';
}

export function collectToolFileOperations(entries, cwd, sessionId) {
  const calls = new Map();
  const byCall = new Map();
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
    const action = fileAction(call.name);
    const argument = call.arguments?.path || call.arguments?.file_path;
    const path = typeof argument === 'string' ? argument.trim() : '';
    const title = path.split(/[\\/]/).at(-1);
    const images = [];
    const files = [];
    for (const [index, block] of message.content.entries()) {
      if (block?.type === 'image' && typeof block.data === 'string' && block.data) {
        images.push({ id: `${entry.id}:${index}`, title, embedded: block });
      }
    }
    if (!images.length && !message.isError && title && action !== 'other') {
      const relative = relativeOutputPath(path, cwd);
      const svg = /\.svg$/i.test(path);
      const written = typeof call.arguments?.content === 'string' ? call.arguments.content : null;
      const href = relative && sessionId ? assetUrl(sessionId, relative) : '';
      if (imageFile.test(path)) {
        images.push({
          id: `${entry.id}:image`,
          title,
          svg,
          svgBlocks: svg && action === 'view' ? message.content : null,
          svgText: svg && action === 'write' ? written : null,
          asset: href && !svg ? assetUrl(sessionId, relative, true) : href,
        });
      } else {
        const kind = filePreviewKind(path);
        files.push({
          id: `${entry.id}:file`,
          title,
          kind,
          href,
          previewUrl: href && assetUrl(sessionId, relative, true),
          content: action === 'write' ? written : null,
          recordedText: action === 'view' ? message.content : null,
          fallbackContent: action === 'edit' ? message.details?.diff : null,
          readWorkspaceText: kind === 'file' && !!href,
        });
      }
    }
    if (images.length || files.length) {
      byCall.set(call.id, { action, images, files, resultId: entry.id, failed: !!message.isError });
    }
  }
  return byCall;
}

export async function resolveToolImage(image, signal, workspacePreviews) {
  if (image.embedded) {
    const mime = image.embedded.mimeType || 'image/png';
    return imageMime.test(mime) ? { url: `data:${mime};base64,${image.embedded.data}` } : null;
  }
  const snapshot = image.svgText || (image.svgBlocks && readSvgSnapshot(image.svgBlocks));
  if (snapshot) return { url: svgPreviewURL(snapshot) };
  if (!image.asset) return null;
  if (!image.svg) return { url: image.asset, workspace: true };

  const key = image.id + image.asset;
  const cached = workspacePreviews.get(key);
  if (cached) return cached;
  const response = await fetch(image.asset, { signal, priority: 'low' });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/svg+xml')) {
    await response.body?.cancel();
    return null;
  }
  const svg = await readPreviewText(response, maxSvgBytes);
  if (signal.aborted || !svg) return null;
  const preview = { url: svgPreviewURL(svg), workspace: true };
  // Reuse small previews when someone opens a step again.
  if (preview.url.length <= 256 * 1024) {
    if (workspacePreviews.size >= 16)
      workspacePreviews.delete(workspacePreviews.keys().next().value);
    workspacePreviews.set(key, preview);
  }
  return preview;
}

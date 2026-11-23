import { assetUrl, relativeOutputPath, svgPreviewURL } from './outputs.js';
import { toolKind } from '../render/conversation-activity.js';

const imageFile = /\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;
const imageMime = /^image\/(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg\+xml|tiff|webp)$/i;

function readSvgSnapshot(blocks) {
  const contents = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const start = contents.search(/<svg(?=[\s/>])/i);
  if (start < 0) return '';
  const svg = contents.slice(start);
  // Pi adds a continuation notice to partial reads. Preview the recorded
  // document only when the SVG itself is complete.
  return /(?:<\/svg\s*>|^<svg\b[^>]*\/>)$/i.test(svg) ? svg : '';
}

export function collectToolImagePreviews(entries, cwd, sessionId) {
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
    const argument = call.arguments?.path || call.arguments?.file_path;
    const path = typeof argument === 'string' && imageFile.test(argument) ? argument : '';
    const title = path.split(/[\\/]/).at(-1);
    const previews = [];
    for (const [index, block] of message.content.entries()) {
      if (block?.type !== 'image' || typeof block.data !== 'string' || !block.data) continue;
      const mime = block.mimeType || 'image/png';
      previews.push({
        id: `${call.id}:${index}`,
        title,
        src: imageMime.test(mime) ? `data:${mime};base64,${block.data}` : '',
      });
    }
    if (!previews.length && !message.isError && toolKind(call.name) === 'read' && path) {
      const relative = relativeOutputPath(path, cwd);
      const svg = /\.svg$/i.test(path);
      const snapshot = svg ? readSvgSnapshot(message.content) : '';
      previews.push({
        id: `${call.id}:file`,
        title,
        src: snapshot
          ? svgPreviewURL(snapshot)
          : relative && sessionId && !svg
            ? assetUrl(sessionId, relative, true)
            : '',
        svgHref: relative && sessionId && svg && !snapshot ? assetUrl(sessionId, relative) : '',
      });
    }
    if (previews.length) byCall.set(call.id, previews);
  }
  return byCall;
}

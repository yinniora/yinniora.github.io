import { t } from '../../shared/i18n.js';
// Pure formatting helpers for rendering conversation entries. Extracted from
// session-entry-renderer.js during its decomposition into Svelte components
// (docs/dev/svelte-migration-plan.md). No DOM, no side effects.

export function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return (count / 1000).toFixed(1) + 'k';
  if (count < 1000000) return Math.round(count / 1000) + 'k';
  return (count / 1000000).toFixed(1) + 'M';
}

export function formatTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Compact clock time for message actions: "10:38" today, "11/18 10:38" otherwise.
export function formatShortTime(ts, now = new Date()) {
  if (!ts) return '';
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) + ' ' + time;
}

// Pi appends a resize note after each attached image so the model can map
// coordinates. It is meant for the model, not for the person reading the chat.
const imageNotePattern =
  /\n?\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/g;
export function stripImageNotes(text) {
  return String(text ?? '')
    .replace(imageNotePattern, '')
    .trimEnd();
}

export function entryTime(entry) {
  const value = entry?.timestamp ?? entry?.message?.timestamp;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatElapsed(ms) {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return t('activity.hours', { h, m });
  if (m) return t('activity.minutes', { m, s });
  return t('activity.seconds', { s });
}

export function replaceTabs(text) {
  return String(text).replace(/\t/g, '   ');
}

// Coerce a value to a display string. Returns null for invalid (non-string,
// non-nullish) types so callers can show an "[invalid arg]" marker.
export function str(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return null;
}

export function getLanguageFromPath(filePath) {
  const ext = String(filePath).split('.').pop()?.toLowerCase();
  const extToLang = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    dockerfile: 'dockerfile',
  };
  return extToLang[ext];
}

// Split text into the first `maxLines` preview lines + the remaining count.
export function splitOutputLines(text, maxLines) {
  const replaced = replaceTabs(text);
  const lines = replaced.split('\n');
  return { lines, preview: lines.slice(0, maxLines), remaining: lines.length - maxLines };
}

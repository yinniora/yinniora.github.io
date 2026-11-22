import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Type } from 'typebox';

const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);
const minimumRepeatedOutput = 4096;
const shellReader = 'pi_web_read_shell_output';
const shellOutputThreshold = 3072;
const wideShellLineBytes = 3072;
const shellExcerptBudget = 4096;
const shellReadBudget = 8192;
const shellDiagnostic =
  /\b(?:error|fatal|panic|traceback|exception|warning|warn|fail|failed|failure|denied|not ok|exit(?:ed)? (?:code|status))\b|npm\s+ERR!|错误|失败|警告|异常/i;
const shellDiagnosticMatches = new RegExp(shellDiagnostic.source, 'gi');
const focusedToolOutput =
  'Batch independent reads. Use narrow file ranges and size-bounded source searches. Reread only to verify changes.';

function plainToolText(message) {
  if (
    message.role !== 'toolResult' ||
    message.isError ||
    message.structuredContent != null ||
    !message.toolCallId ||
    message.content?.length !== 1
  )
    return;
  const [content] = message.content;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
}

export function deduplicateToolOutput(messages) {
  const firstOccurrence = new Map();
  let updated;
  for (const [index, message] of messages.entries()) {
    if (!readOnlyTools.has(message.toolName)) continue;
    const text = plainToolText(message);
    if (!text || text.length < minimumRepeatedOutput) continue;

    const hash = createHash('sha256')
      .update(message.toolName)
      .update('\0')
      .update(text)
      .digest('hex');
    const first = firstOccurrence.get(hash);
    if (!first) {
      firstOccurrence.set(hash, message.toolCallId);
      continue;
    }
    // Only refer backward so new results never invalidate the existing cache prefix.
    updated ||= messages.slice();
    updated[index] = {
      ...message,
      content: [
        {
          type: 'text',
          text: `Output is identical to the earlier ${message.toolName} result (${first}).`,
        },
      ],
    };
  }
  return updated;
}

function isJSON(text) {
  const first = text.trimStart()[0];
  if (first === '[' || first === '{') {
    try {
      JSON.parse(text);
      return true;
    } catch {
      // Bracket-prefixed log lines are common in plain shell output.
    }
  }
  return false;
}

function largeShellOutput(message) {
  if (message.toolName !== 'bash') return;
  const text = plainToolText(message);
  if (!text) return;
  const bytes = Buffer.byteLength(text);
  if (bytes < shellOutputThreshold) return;
  const lines = text.split('\n');
  const hasWideLines = lines.some((line) => Buffer.byteLength(line) > wideShellLineBytes);
  if ((lines.length < 48 && !hasWideLines) || isJSON(text)) return;
  return { lines, bytes, hasWideLines };
}

function wideShellExcerpt(line) {
  if (Buffer.byteLength(line) <= 768) return line;
  // Leave the entire result intact when a retained line contains JSON or terminal controls.
  if (line !== stripVTControlCharacters(line) || isJSON(line)) return undefined;

  const columns = Array.from(line);
  const windows = [[0, Math.min(128, columns.length)]];
  let offset = 0;
  let column = 0;
  for (const match of line.matchAll(shellDiagnosticMatches)) {
    column += Array.from(line.slice(offset, match.index)).length;
    offset = match.index;
    windows.push([Math.max(0, column - 24), Math.min(columns.length, column + match[0].length + 36)]);
  }
  windows.push([Math.max(0, columns.length - 96), columns.length]);
  windows.sort(([a], [b]) => a - b);

  const merged = [];
  for (const [start, end] of windows) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(end, previous[1]);
    else merged.push([start, end]);
  }
  if (merged.length === 1) return line;
  return merged
    .map(([start, end]) => `[${start + 1}–${end}] ${columns.slice(start, end).join('')}`)
    .join(' … ');
}

function shellExcerpt({ lines, bytes, hasWideLines }, toolCallId) {
  const output = [
    `[Bash output excerpt. Use ${shellReader} with toolCallId ${JSON.stringify(toolCallId)} for omitted lines${hasWideLines ? ' or columns' : ''}.]`,
  ];
  const keep = new Set();
  for (let index = 0; index < lines.length; index++) {
    if (index < 8 || index >= lines.length - 16) keep.add(index);
    if (shellDiagnostic.test(stripVTControlCharacters(lines[index]))) {
      if (index > 0) keep.add(index - 1);
      keep.add(index);
      if (index + 1 < lines.length) keep.add(index + 1);
    }
  }

  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) output.push(`[Lines ${previous + 2}–${index} omitted]`);
    const line = hasWideLines ? wideShellExcerpt(lines[index]) : lines[index];
    if (line === undefined) return;
    output.push(`${index + 1} | ${line}`);
    previous = index;
  }
  const excerpt = output.join('\n');
  const budget = Math.min(shellExcerptBudget, bytes * 0.7);
  if (Buffer.byteLength(excerpt) <= budget) return excerpt;
}

function projectShellOutput(messages) {
  let updated;
  for (const [index, message] of messages.entries()) {
    const output = largeShellOutput(message);
    if (!output) continue;
    const excerpt = shellExcerpt(output, message.toolCallId);
    if (!excerpt) continue;
    updated ||= messages.slice();
    updated[index] = { ...message, content: [{ type: 'text', text: excerpt }] };
  }
  return updated;
}

function declaresShellReader(messages) {
  let available = false;
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (message.toolsRemoved?.some(({ name }) => name === shellReader)) available = false;
    if (message.toolsAdded?.some(({ name }) => name === shellReader)) available = true;
  }
  return available;
}

function readShellColumns(line, lineNumber, startColumn) {
  const columns = Array.from(line);
  if (!Number.isInteger(startColumn) || startColumn < 1 || startColumn > columns.length) {
    throw new Error(`Choose a column from 1 to ${columns.length} on line ${lineNumber}.`);
  }

  let remaining = shellReadBudget - 160;
  let end = startColumn - 1;
  for (; end < columns.length; end++) {
    remaining -= Buffer.byteLength(columns[end]);
    if (remaining < 0) break;
  }
  const text = [
    `Bash output line ${lineNumber}, columns ${startColumn}–${end} of ${columns.length}.`,
    `${lineNumber} | ${columns.slice(startColumn - 1, end).join('')}`,
  ];
  if (end < columns.length) text.push(`Continue with startColumn ${end + 1}.`);
  return text.join('\n');
}

function findShellText(lines, findText, startLine, startColumn = 1) {
  const literal = typeof findText === 'string' ? Array.from(findText) : [];
  if (!literal.length || literal.length > 256 || /[\r\n\uD800-\uDFFF]/u.test(findText)) {
    throw new Error('Choose one line of literal search text (1–256 Unicode code points).');
  }
  const firstLine = Array.from(lines[startLine - 1]);
  if (!Number.isInteger(startColumn) || startColumn < 1 || startColumn > firstLine.length + 1) {
    throw new Error(`Choose a column from 1 to ${firstLine.length + 1} on line ${startLine}.`);
  }

  let offset = firstLine.slice(0, startColumn - 1).join('').length;
  for (let index = startLine - 1; index < lines.length; index++, offset = 0) {
    const match = lines[index].indexOf(findText, offset);
    if (match === -1) continue;
    const column = Array.from(lines[index].slice(0, match)).length;
    const columns = Array.from(lines[index]);
    const start = Math.max(0, column - 48);
    const end = Math.min(columns.length, column + literal.length + 48);
    return `Bash output match at line ${index + 1}, column ${column + 1} (showing columns ${start + 1}–${end}).\n${index + 1} | ${columns.slice(start, end).join('')}`;
  }
  return `No exact match found from line ${startLine}, column ${startColumn}.`;
}

function readShellOutput(
  { toolCallId, startLine, lineCount = 24, startColumn, findText },
  sessionManager,
) {
  // Native projection limits retrieval to the current branch and respects context edits.
  const result = sessionManager
    ?.buildSessionProjection?.()
    .messages.findLast(
      (message) => message.role === 'toolResult' && message.toolCallId === toolCallId,
    );
  const lines = result && largeShellOutput(result)?.lines;
  if (!lines) throw new Error('No matching Bash output in the active model context.');
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length) {
    throw new Error(`Choose a start line from 1 to ${lines.length}.`);
  }
  if (findText !== undefined) return findShellText(lines, findText, startLine, startColumn);
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 64) {
    throw new Error('Choose a line count from 1 to 64.');
  }
  if (startColumn !== undefined) {
    return readShellColumns(lines[startLine - 1], startLine, startColumn);
  }

  let remaining = shellReadBudget - 80;
  let index = startLine - 1;
  const output = [];
  for (; index < Math.min(lines.length, startLine + lineCount - 1); index++) {
    const line = `${index + 1} | ${lines[index]}`;
    remaining -= Buffer.byteLength(line) + 1;
    if (remaining < 0) {
      if (output.length === 0) return readShellColumns(lines[index], startLine, 1);
      break;
    }
    output.push(line);
  }
  const heading = `Bash output lines ${startLine}–${index} of ${lines.length}.`;
  return [heading, ...output].join('\n');
}

export function protectProviderRedirects(fetchImpl) {
  return async (input, init) => {
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    const target = input?.url ?? input;
    if (method !== 'POST' || !URL.canParse(target)) return fetchImpl(input, init);
    const url = new URL(target);
    const inferencePath = /\/(?:responses|chat\/completions|messages(?:\/count_tokens)?|[^/]+:(?:streamGenerateContent|generateContent))\/?$/;
    if (!inferencePath.test(url.pathname)) {
      return fetchImpl(input, init);
    }
    const headers = new Headers(init?.headers ?? input?.headers);
    const authHeaders = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cf-aig-authorization'];
    if (!authHeaders.some((name) => headers.has(name)) && !url.searchParams.has('key')) {
      return fetchImpl(input, init);
    }
    const response = await fetchImpl(input, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    return Response.json(
      { error: { message: 'The model service redirected the request. Use its final API address.' } },
      { status: 400 },
    );
  };
}

export default function setupHarness(pi) {
  globalThis.fetch = protectProviderRedirects(globalThis.fetch);
  pi.registerTool({
    name: shellReader,
    label: 'Read Bash output',
    description:
      'Read recorded Bash output or findText literally. Columns are 1-based Unicode code points.',
    exposure: 'model-only',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      toolCallId: Type.String(),
      startLine: Type.Integer({ minimum: 1 }),
      lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      startColumn: Type.Optional(Type.Integer({ minimum: 1 })),
      findText: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = readShellOutput(params, ctx.sessionManager);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  pi.on('before_agent_start', (event) => {
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (guidelines && !guidelines.includes(focusedToolOutput)) guidelines.push(focusedToolOutput);
  });

  pi.on('context_with_system', ({ messages }, ctx) => {
    const deduplicated = deduplicateToolOutput(messages);
    const excerpted =
      typeof ctx?.sessionManager?.buildSessionProjection === 'function' &&
      declaresShellReader(messages)
        ? projectShellOutput(deduplicated || messages)
        : undefined;
    if (excerpted || deduplicated) return { messages: excerpted || deduplicated };
  });

  // Preserve native prompt caching during a real turn without buying idle requests.
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
}

import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Type } from 'typebox';

const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);
const minimumRepeatedOutput = 4096;
const shellReader = 'pi_web_read_shell_output';
const shellOutputThreshold = 3072;
const shellExcerptBudget = 4096;
const shellReadBudget = 8192;
const shellDiagnostic =
  /\b(?:error|fatal|panic|traceback|exception|warning|warn|fail|failed|failure|denied|not ok|exit(?:ed)? (?:code|status))\b|npm\s+ERR!|错误|失败|警告|异常/i;
const focusedToolOutput =
  'Use targeted searches, file ranges, and bounded command output. Repeat a read only when necessary to verify the current state.';

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

function largeShellOutput(message) {
  if (message.toolName !== 'bash') return;
  const text = plainToolText(message);
  if (!text) return;
  const bytes = Buffer.byteLength(text);
  if (bytes < shellOutputThreshold) return;
  const lines = text.split('\n');
  if (lines.length < 48 || lines.some((line) => Buffer.byteLength(line) > 3072)) return;
  const first = text.trimStart()[0];
  if (first === '[' || first === '{') {
    try {
      JSON.parse(text);
      return;
    } catch {
      // Bracket-prefixed log lines are common in plain shell output.
    }
  }
  return { lines, bytes };
}

function shellExcerpt({ lines, bytes }, toolCallId) {
  const output = [
    `[Bash output excerpt. Use ${shellReader} with toolCallId ${JSON.stringify(toolCallId)} for omitted lines.]`,
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
    output.push(`${index + 1} | ${lines[index]}`);
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

function readShellOutput({ toolCallId, startLine, lineCount = 24 }, sessionManager) {
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
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 64) {
    throw new Error('Choose a line count from 1 to 64.');
  }

  let remaining = shellReadBudget - 80;
  let index = startLine - 1;
  const output = [];
  for (; index < Math.min(lines.length, startLine + lineCount - 1); index++) {
    const line = `${index + 1} | ${lines[index]}`;
    remaining -= Buffer.byteLength(line) + 1;
    if (remaining < 0) break;
    output.push(line);
  }
  const heading = `Bash output lines ${startLine}–${index} of ${lines.length}.`;
  const text = [heading, ...output].join('\n');
  return { content: [{ type: 'text', text }], details: undefined };
}

export default function setupHarness(pi) {
  pi.registerTool({
    name: shellReader,
    label: 'Read Bash output',
    description:
      'Read omitted lines from recorded Bash output in this conversation by tool call ID.',
    exposure: 'model-only',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      toolCallId: Type.String(),
      startLine: Type.Integer({ minimum: 1 }),
      lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return readShellOutput(params, ctx.sessionManager);
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

  pi.on('cache_warming_decision', (_event, ctx) => {
    // Custom credentials can be billed per request. Pi's token-based warm cost
    // estimates cannot represent these plans. Native prompt caching still runs.
    if (ctx.model?.provider?.startsWith('yugo-')) return { action: 'stop' };
  });
}

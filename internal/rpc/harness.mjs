import { createHash } from 'node:crypto';

const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);
const minimumRepeatedOutput = 4096;
const focusedToolOutput =
  'Use targeted searches, file ranges, and bounded command output. Repeat a read only when necessary to verify the current state.';

export function deduplicateToolOutput(messages) {
  const firstOccurrence = new Map();
  let updated;
  for (const [index, message] of messages.entries()) {
    if (
      message.role !== 'toolResult' ||
      message.isError ||
      message.structuredContent != null ||
      !readOnlyTools.has(message.toolName) ||
      !message.toolCallId ||
      message.content?.length !== 1
    )
      continue;
    const [content] = message.content;
    if (
      content.type !== 'text' ||
      typeof content.text !== 'string' ||
      content.text.length < minimumRepeatedOutput
    )
      continue;

    const hash = createHash('sha256')
      .update(message.toolName)
      .update('\0')
      .update(content.text)
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

export default function setupHarness(pi) {
  pi.on('before_agent_start', (event) => {
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (guidelines && !guidelines.includes(focusedToolOutput)) guidelines.push(focusedToolOutput);
  });

  pi.on('context_with_system', (event) => {
    const messages = deduplicateToolOutput(event.messages);
    if (messages) return { messages };
  });

  pi.on('cache_warming_decision', (_event, ctx) => {
    // Custom credentials can be billed per request. Pi's token-based warm cost
    // estimates cannot represent these plans. Native prompt caching still runs.
    if (ctx.model?.provider?.startsWith('yugo-')) return { action: 'stop' };
  });
}

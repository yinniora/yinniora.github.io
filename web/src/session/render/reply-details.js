const transportError =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_[A-Z_]+)\b|socket hang up|secure TLS connection/i;

// The server's recovery prompt after a provider closed a turn with an empty
// reply (internal/rpc/worker.go EmptyReplyContinuePrompt).
export const AUTO_CONTINUE_PROMPT = 'Continue.';

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    : '';
}

function isEmptyStop(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return (
    message?.role === 'assistant' &&
    message.stopReason === 'stop' &&
    !blocks.length &&
    !(message.usage?.output > 0)
  );
}

// An empty reply followed right away by the recovery prompt: the task went on.
function autoContinuedEntries(entries) {
  const ids = new Set();
  let empty = null;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (empty && message?.role === 'user' && messageText(message).trim() === AUTO_CONTINUE_PROMPT) {
      ids.add(empty);
      ids.add(entry.id);
    }
    empty = isEmptyStop(message) ? entry.id : null;
  }
  return ids;
}

// A failed attempt that the agent retried, and that a later reply in the same
// turn already replaced, must not read as "the task ended with an error".
function retriedErrors(entries, running) {
  const superseded = new Set();
  let pending = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') {
      pending = [];
      continue;
    }
    if (message?.role !== 'assistant') continue;
    if (message.stopReason === 'error') {
      const error = String(message.errorMessage || '');
      if (
        /ECONNRESET|ETIMEDOUT|connection error|timed out|timeout|overloaded|rate.?limit|\b(408|429|500|502|503|504|529)\b/i.test(
          error,
        ) &&
        !/quota|billing|balance|permission|unauthorized|forbidden|model_not_found|aborted|cancelled/i.test(
          error,
        )
      )
        pending.push(entry.id);
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const recovered =
      message.stopReason !== 'aborted' &&
      (blocks.some((block) => block.type === 'text' && block.text?.trim()) ||
        blocks.some((block) => block.type === 'toolCall'));
    if (recovered && pending.length) {
      for (const id of pending) superseded.add(id);
      pending = [];
    }
  }
  if (running) for (const id of pending) superseded.add(id);
  return superseded;
}

export function entriesWithReplyDetails(entries, { running = false } = {}) {
  const autoContinued = autoContinuedEntries(entries);
  const retried = retriedErrors(entries, running);
  const repeatedErrors = new Set();
  let nextError = '';
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'message') continue;
    const message = entry.message;
    const error = message?.errorMessage || '';
    const rejection =
      message?.role === 'assistant' && message.stopReason === 'error'
        ? /"(?:type|code)"\s*:\s*"(model_not_found|model_not_allowed)"/.exec(error)?.[1] ||
          (transportError.test(error) ? 'transport' : '')
        : '';
    const key = rejection && `${message.provider}/${message.model}/${rejection}`;
    if (key && key === nextError) repeatedErrors.add(entry.id);
    nextError = key;
  }
  let previousModel = '';
  let prompt = null;
  return entries.map((entry) => {
    if (entry.type === 'model_change' && entry.modelId) {
      previousModel = [entry.provider, entry.modelId].filter(Boolean).join('/');
    }
    const message = entry.type === 'message' && entry.message;
    if (autoContinued.has(entry.id)) return { entry, autoContinued: true };
    if (message?.role === 'user') prompt = message.content;
    if (repeatedErrors.has(entry.id)) return { entry, repeatedError: true };
    if (retried.has(entry.id)) return { entry, retried: true };
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      return { entry, retryContent: prompt };
    }
    if (message?.role !== 'assistant' || message.stopReason === 'toolUse') {
      return { entry, reply: null };
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    if (!message.stopReason && blocks.some((block) => block.type === 'toolCall')) {
      return { entry, reply: null };
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : blocks
            .filter((block) => block.type === 'text' && block.text?.trim())
            .map((block) => block.text)
            .join('\n\n');
    const interrupted = message.stopReason === 'aborted';
    if (!text.trim() && !interrupted) {
      const emptyReply =
        message.stopReason === 'stop' &&
        !blocks.some((block) => ['image', 'toolCall'].includes(block.type));
      return { entry, reply: null, emptyReply, retryContent: emptyReply ? prompt : null };
    }

    const model = message.model
      ? [message.provider, message.model].filter(Boolean).join('/')
      : previousModel;
    return {
      entry,
      reply: { text, model, timestamp: entry.timestamp || message.timestamp },
      retryContent: interrupted ? prompt : null,
    };
  });
}

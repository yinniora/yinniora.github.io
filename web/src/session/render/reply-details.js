const transportError =
  /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|socket hang up|socket disconnected|fetch failed|connection error/i;
const terminalError =
  /quota|billing|balance|permission|unauthorized|forbidden|invalid api key|unsupported_compat_parameter|model_not_found|model_not_allowed|\baborted\b|\bcancell?ed\b/i;

const providerFailureLabels = {
  tls: 'activity.modelTlsFailed',
  connect: 'activity.modelConnectFailed',
  timeout: 'activity.modelTimeout',
  stream: 'activity.modelStreamInterrupted',
  transport: 'activity.modelConnectionInterrupted',
};

export function providerFailureLabelKey(stage) {
  return Object.hasOwn(providerFailureLabels, stage) ? providerFailureLabels[stage] : '';
}

export function providerNetworkFailure(rawError) {
  const error = String(rawError || '');
  if (terminalError.test(error)) return '';
  if (
    /before (?:a )?secure TLS connection was established|TLS handshake (?:timed out|timeout)/i.test(
      error,
    )
  ) {
    return 'tls';
  }
  if (
    /\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)\b|connection refused|connect (?:timeout|timed out)/i.test(
      error,
    )
  ) {
    return 'connect';
  }
  if (
    /stream ended (?:before (?:message_stop|a terminal response event)|without)|stream disconnected before completion|stream was interrupted|upstream_stream_read_error|\bUND_ERR_BODY_TIMEOUT\b|cut short after the reply had begun/i.test(
      error,
    )
  ) {
    return 'stream';
  }
  if (/\bETIMEDOUT\b|\btimed out\b|\btimeout\b|\b(?:504|524)\b/i.test(error)) return 'timeout';
  return transportError.test(error) ? 'transport' : '';
}

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
  const omitted = new Set(
    entries
      .filter((entry) => entry.type === 'context_edit' && entry.replacement === null)
      .map((entry) => entry.targetId),
  );
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
      // Pi may omit an attempt before waiting to retry. A later failure proves
      // the earlier attempt advanced, but the final one must stay visible.
      for (const id of pending) if (omitted.has(id)) superseded.add(id);
      const error = String(message.errorMessage || '');
      if (
        providerNetworkFailure(error) ||
        (!terminalError.test(error) &&
          /overloaded|rate.?limit|\b(408|429|500|502|503|504|529)\b/i.test(error))
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
  const latestMessage = entries.findLast(
    ({ type, message }) =>
      type === 'message' && (message?.role === 'user' || message?.role === 'assistant'),
  );
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
          providerNetworkFailure(error)
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
      return {
        entry,
        retryContent: prompt,
        canResumeNetworkFailure:
          entry === latestMessage && Boolean(providerNetworkFailure(message.errorMessage)),
      };
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

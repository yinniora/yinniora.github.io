const transportError =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_[A-Z_]+)\b|socket hang up|secure TLS connection/i;

export function entriesWithReplyDetails(entries) {
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
    if (message?.role === 'user') prompt = message.content;
    if (repeatedErrors.has(entry.id)) return { entry, repeatedError: true };
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
    if (!text.trim() && !interrupted) return { entry, reply: null };

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

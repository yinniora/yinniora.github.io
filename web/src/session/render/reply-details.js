export function entriesWithReplyDetails(entries) {
  let previousModel = '';
  return entries.map((entry) => {
    if (entry.type === 'model_change' && entry.modelId) {
      previousModel = [entry.provider, entry.modelId].filter(Boolean).join('/');
    }
    const message = entry.type === 'message' && entry.message;
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
    if (!text.trim()) return { entry, reply: null };

    const model = message.model
      ? [message.provider, message.model].filter(Boolean).join('/')
      : previousModel;
    return {
      entry,
      reply: { text, model, timestamp: entry.timestamp || message.timestamp },
    };
  });
}

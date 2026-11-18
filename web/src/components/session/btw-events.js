export function createBtwEventSource(topic, { EventSourceImpl = EventSource } = {}) {
  return new EventSourceImpl('/events?id=' + encodeURIComponent(topic));
}

export function setupBtwSessionEvents({
  sessionId = '',
  EventSourceImpl = typeof EventSource !== 'undefined' ? EventSource : null,
  onReload = () => {},
  onChatPreview = () => {},
} = {}) {
  if (!sessionId || !EventSourceImpl) return null;
  const source = createBtwEventSource(sessionId, { EventSourceImpl });
  let lastRevision = 0;
  source.addEventListener('open', () => (lastRevision = 0));
  source.onmessage = (event) => {
    if (event.data === 'reload') onReload();
  };
  source.addEventListener('chat-preview', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.revision) {
        if (payload.revision <= lastRevision) return;
        lastRevision = payload.revision;
      }
      onChatPreview(payload);
    } catch {
      // Ignore malformed preview events; they are best-effort.
    }
  });
  source.onerror = () => {};
  return source;
}

export function setupBtwParentEvents({
  parentTopic = '',
  EventSourceImpl = typeof EventSource !== 'undefined' ? EventSource : null,
  onChanged = () => {},
} = {}) {
  if (!parentTopic || !EventSourceImpl) return null;
  const source = createBtwEventSource(parentTopic, { EventSourceImpl });
  source.addEventListener('btw-changed', (event) => {
    try {
      const payload = JSON.parse(event.data);
      onChanged(payload.sessionId || '');
    } catch {
      // Ignore malformed registry events.
    }
  });
  source.onerror = () => {};
  return source;
}

export function closeBtwEventSource(source) {
  try {
    source?.close?.();
  } catch {
    // Already closed or nonstandard EventSource; nothing to do.
  }
}

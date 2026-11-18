import { createSessionEventSource, wireSessionEvents } from './live-events.js';

const EVENT_SOURCE_CLOSED = 2;

export function reconnectDelay(attempt, { randomImpl = Math.random } = {}) {
  const base = Math.min(30000, 1000 * Math.pow(2, attempt));
  return base + Math.floor(randomImpl() * 500);
}

export function setupSessionLiveConnection({
  documentImpl = document,
  windowImpl = window,
  sessionId,
  createEventSource = createSessionEventSource,
  wireEvents = wireSessionEvents,
  onReload = () => {},
  onChatPreview = () => {},
  onAnnotations = () => {},
  onError = () => {},
  setTimeoutImpl = windowImpl.setTimeout.bind(windowImpl),
  clearTimeoutImpl = windowImpl.clearTimeout.bind(windowImpl),
  randomImpl = Math.random,
} = {}) {
  let eventSource = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  function closeEventSource() {
    const previous = eventSource;
    eventSource = null;
    try {
      previous?.close();
    } catch (_) {}
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function connect() {
    clearReconnectTimer();
    closeEventSource();
    const source = createEventSource(sessionId, { EventSourceImpl: windowImpl.EventSource });
    eventSource = source;
    wireEvents({
      eventSource: source,
      isActive: () => eventSource === source,
      onReload,
      onChatPreview,
      onAnnotations,
      onError: (error) => {
        if (eventSource !== source) return;
        onError(error);
        if (source.readyState !== EVENT_SOURCE_CLOSED) return;
        scheduleReconnect();
      },
      windowImpl,
      CustomEventImpl: windowImpl.CustomEvent,
    });
    reconnectAttempt = 0;
    return eventSource;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelay(reconnectAttempt, { randomImpl });
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
      onReload();
    }, delay);
  }

  function reconnectAndReload() {
    reconnectAttempt = 0;
    connect();
    onReload();
  }

  const onVisibilityChange = () => {
    if (documentImpl.hidden) return;
    if (!eventSource || eventSource.readyState === EVENT_SOURCE_CLOSED) {
      reconnectAndReload();
    } else {
      onReload();
    }
  };
  const onOnline = () => {
    reconnectAndReload();
  };

  documentImpl.addEventListener('visibilitychange', onVisibilityChange);
  windowImpl.addEventListener('online', onOnline);

  return {
    connect,
    scheduleReconnect,
    currentEventSource: () => eventSource,
    dispose: () => {
      clearReconnectTimer();
      closeEventSource();
      documentImpl.removeEventListener('visibilitychange', onVisibilityChange);
      windowImpl.removeEventListener('online', onOnline);
    },
  };
}

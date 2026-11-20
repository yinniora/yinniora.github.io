import { t } from '../../../shared/i18n.js';

export function setupWorkerStatusPolling({
  windowImpl = window,
  chatApi,
  sessionId = '',
  setStatus = () => {},
  setModelLabel = () => {},
  setThinkingLabel = () => {},
  updateContextUsage = () => {},
  getKnownModelLabel = () => '',
  setKnownModelLabel = () => {},
  getKnownThinkingLevel = () => '',
  setKnownThinkingLevel = () => {},
  getWorkerModelUpdate = () => null,
  setCompacting = () => {},
  setWorkerRunning = () => {},
  setExtensionUI = () => {},
  deliveryPending = () => false,
  setIntervalImpl = windowImpl.setInterval?.bind(windowImpl),
  clearIntervalImpl = windowImpl.clearInterval?.bind(windowImpl),
  CustomEventImpl = windowImpl.CustomEvent,
  intervalMs = 1500,
} = {}) {
  let inflight = false;
  let pending = false;
  let lastWorkerState = null;
  let lastHandledPrompt = '';
  const scope = new AbortController();

  async function refresh() {
    if (scope.signal.aborted) return;
    if (inflight) {
      // Queue exactly one follow-up so an in-flight response cannot swallow a
      // newer state change, such as the assistant finishing while we poll stale
      // "running" state.
      pending = true;
      return;
    }
    inflight = true;
    try {
      const response = await chatApi?.getWorkerStatus?.(sessionId, { signal: scope.signal });
      if (!response?.ok) return;
      const data = await response.json();
      if (scope.signal.aborted) return;
      setExtensionUI(data.extensionUI);
      const apiModelLabel = data.model
        ? data.model + (data.modelProvider ? ' @ ' + data.modelProvider : '')
        : '';
      if (apiModelLabel) setKnownModelLabel(apiModelLabel);
      if (data.thinkingLevel) setKnownThinkingLevel(data.thinkingLevel);
      setCompacting(Boolean(data.compacting));
      setWorkerRunning(data.state === 'running' && Boolean(data.model));
      const deliver = deliveryPending();
      if (!deliver && data.state === 'running') setStatus('running', 'running');
      if (!deliver && data.state === 'idle') {
        if (data.compactionFailed) setStatus(t('piSession.compactFailed'), 'error');
        else setStatus('idle', '');
      }
      if (!deliver && data.state === 'error')
        setStatus(
          data.error === 'context compaction failed'
            ? t('piSession.compactFailed')
            : data.error || 'worker error',
          'error',
        );
      if (
        !deliver &&
        (data.state === 'idle' || data.state === 'error') &&
        (lastWorkerState === 'running' ||
          (data.handledPrompt && lastHandledPrompt !== data.handledPrompt))
      ) {
        try {
          windowImpl.dispatchEvent(new CustomEventImpl('pi-worker-done'));
        } catch {
          // Some tests/environments may not support constructing events.
        }
      }
      lastHandledPrompt = data.handledPrompt || '';
      if (data.state && !deliver) lastWorkerState = data.state;
      setModelLabel(getKnownModelLabel());
      setThinkingLabel(getKnownThinkingLevel());
      updateContextUsage();
      const onWorkerModelUpdate = getWorkerModelUpdate?.();
      if (data.modelProvider && data.model && onWorkerModelUpdate) {
        onWorkerModelUpdate(data.modelProvider, data.model, data.thinkingLevels);
      }
    } catch {
      // A failed poll does not change the last known Pi run state.
    } finally {
      inflight = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  }

  const timer = setIntervalImpl?.(refresh, intervalMs);
  void refresh();
  updateContextUsage();

  const onSessionReload = () => {
    void refresh();
    updateContextUsage();
  };
  windowImpl.addEventListener?.('pi-session-reload', onSessionReload);

  return {
    refresh,
    dispose: () => {
      scope.abort();
      if (timer != null) clearIntervalImpl?.(timer);
      windowImpl.removeEventListener?.('pi-session-reload', onSessionReload);
    },
  };
}

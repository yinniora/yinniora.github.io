export function isRunningStatus(text, cls) {
  return (
    cls === 'running' ||
    text === 'running' ||
    text === 'sending' ||
    text === 'queued' ||
    text === 'accepted' ||
    text === 'cancelling'
  );
}

// Reactive toolbar state shared between the live runtime (chat-composer-runtime.js)
// and the declarative <ChatToolbar>. The runtime mutates these fields; the
// component reads them through bindings. Replaces the former imperative
// getElementById/textContent DOM mutation. Live-only.
export class ChatToolbarState {
  statusText = $state('');
  statusClass = $state('');
  modelLabel = $state('');
  thinkingLevel = $state('');
  canAdjustThinking = $state(false);
  compacting = $state(false);
  selectedModel = $state(null);
  knownModelLabel = $state('');
  knownThinkingLevel = $state('');
  workerRunning = $state(false);
  runningSendMode = $state('steer');

  // Injected by the runtime once the context-usage controller exists.
  updateContextUsage = () => {};

  isRunning = $derived(isRunningStatus(this.statusText, this.statusClass));
  // A recent transcript write can report running before there is an active RPC worker.
  hasActiveRun = $derived(
    this.workerRunning || ['sending', 'queued', 'accepted'].includes(this.statusText),
  );
  sendAction = $derived(this.hasActiveRun ? this.runningSendMode : 'send');

  setStatus = (text, cls = '') => {
    this.statusText = text;
    this.statusClass = cls;
  };

  setModelLabel = (label) => {
    if (label) this.modelLabel = label;
    this.updateContextUsage();
  };

  setThinkingLabel = (level) => {
    this.thinkingLevel = level || '';
  };

  getKnownModelLabel = () => this.knownModelLabel;
  setKnownModelLabel = (label) => {
    this.knownModelLabel = label;
  };
  getKnownThinkingLevel = () => this.knownThinkingLevel;
  setKnownThinkingLevel = (level) => {
    this.knownThinkingLevel = level;
  };
}

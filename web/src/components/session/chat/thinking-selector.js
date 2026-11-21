import {
  THINKING_LEVELS,
  detectCurrentThinkingLevel,
  supportedThinkingLevels,
} from '../../../session/chat/chat-selectors.js';
import { t } from '../../../shared/i18n.js';
import { icon, Check } from '../../../shared/icons.js';
import { escapeHtml } from '../../../session/render/session-format.js';

export function setupThinkingLevelSelector({
  documentImpl = document,
  scope,
  sessionId,
  entries = [],
  getCurrentModel = () => null,
  getKnownThinkingLevel = () => '',
  setKnownThinkingLevel = () => {},
  setThinkingLabel = () => {},
  setChatStatus = () => {},
  isChangingModel = () => false,
  showPickerError = () => {},
  chatApi,
} = {}) {
  const thinkingControls = documentImpl.getElementById('pi-chat-effort-controls');
  const thinkingList = documentImpl.getElementById('pi-chat-thinking-list');
  if (!thinkingControls || !thinkingList) return false;

  let generation = 0;
  let pendingChange = Promise.resolve();
  let queuedChanges = 0;
  let confirmedLevel = getKnownThinkingLevel();
  let previousLevels = '';

  function refresh() {
    const model = getCurrentModel();
    const levels = model ? supportedThinkingLevels(model) : [];
    thinkingControls.hidden = levels.length <= 1;
    const key = levels.join(',');
    if (key !== previousLevels) {
      const mark = icon(Check, { size: 14, class: 'thinking-choice-mark' });
      thinkingList.innerHTML = levels
        .map((level) => {
          const label = escapeHtml(t('thinking.' + level));
          return (
            '<button type="button" class="thinking-level-item" data-level="' +
            level +
            '">' +
            mark +
            '<span>' +
            label +
            '</span></button>'
          );
        })
        .join('');
      previousLevels = key;
    }
    const selectedLevel = getKnownThinkingLevel();
    for (const item of thinkingList.querySelectorAll('.thinking-level-item')) {
      const active = selectedLevel === item.dataset.level;
      item.classList.toggle('selected', active);
      item.setAttribute('aria-pressed', String(active));
    }
  }

  function changeThinkingLevel(level, optimistic) {
    if (scope?.aborted || isChangingModel()) return;
    const current = getKnownThinkingLevel();
    if (!level || level === current || !supportedThinkingLevels(getCurrentModel()).includes(level))
      return;
    if (queuedChanges === 0) confirmedLevel = current;
    queuedChanges++;
    const requestedGeneration = ++generation;
    showPickerError();
    if (optimistic) {
      setKnownThinkingLevel(level);
      setThinkingLabel(level);
      refresh();
    }

    const run = async () => {
      try {
        if (scope?.aborted || requestedGeneration !== generation) return;
        const response = await chatApi.setThinkingLevel(sessionId, level);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'set thinking level failed');
        confirmedLevel = result.thinkingLevel || level;
        if (scope?.aborted || requestedGeneration !== generation) return;
        setKnownThinkingLevel(confirmedLevel);
        setThinkingLabel(confirmedLevel);
      } catch (err) {
        if (scope?.aborted || requestedGeneration !== generation) return;
        setKnownThinkingLevel(confirmedLevel);
        setThinkingLabel(confirmedLevel);
        const error = err.message || String(err);
        if (!showPickerError(error)) setChatStatus(error, 'error');
      } finally {
        queuedChanges--;
        if (!scope?.aborted) refresh();
      }
    };
    pendingChange = pendingChange.catch(() => {}).then(run);
    return pendingChange;
  }

  thinkingList.addEventListener(
    'click',
    (event) => {
      const item = event.target.closest('.thinking-level-item');
      if (!item || item.disabled) return;
      void changeThinkingLevel(item.dataset.level, false);
    },
    { signal: scope },
  );

  const detectedLevel = detectCurrentThinkingLevel(entries);
  if (detectedLevel) {
    confirmedLevel = detectedLevel;
    setKnownThinkingLevel(detectedLevel);
    setThinkingLabel(detectedLevel);
  }
  refresh();

  return {
    cycle: () => {
      const levels = supportedThinkingLevels(getCurrentModel(), THINKING_LEVELS);
      const index = levels.indexOf(getKnownThinkingLevel());
      return changeThinkingLevel(levels[(index + 1) % levels.length], true);
    },
    refresh,
    whenSettled: () => pendingChange,
    changeGeneration: () => generation,
    isChangingEffort: () => queuedChanges > 0,
  };
}

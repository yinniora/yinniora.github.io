import {
  THINKING_LEVELS,
  detectCurrentThinkingLevel,
  supportedThinkingLevels,
} from '../../../session/chat/chat-selectors.js';
import { t } from '../../../shared/i18n.js';
import { icon, Check } from '../../../shared/icons.js';
import { escapeHtml } from '../../../session/render/session-format.js';

export function renderThinkingLevelList({
  levels = THINKING_LEVELS,
  selectedLevel = '',
  currentModel = null,
} = {}) {
  const supported = supportedThinkingLevels(currentModel, levels);
  let html = '';
  supported.forEach((level) => {
    const active = level === selectedLevel ? ' selected' : '';
    const label = escapeHtml(t('thinking.' + level));
    const mark = active ? icon(Check, { size: 16, strokeWidth: 2.5 }) : '';
    html += `<button type="button" class="thinking-level-item${active}" data-level="${level}" aria-pressed="${Boolean(active)}"><span>${label}</span>${mark}</button>`;
  });
  return html;
}

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
  chatApi,
} = {}) {
  const thinkingLabelBtn = documentImpl.getElementById('pi-chat-thinking-label');
  const thinkingPopup = documentImpl.getElementById('pi-chat-thinking-popup');
  const thinkingList = documentImpl.getElementById('pi-chat-thinking-list');
  if (!thinkingLabelBtn || !thinkingPopup || !thinkingList) return false;

  let cycleGeneration = 0;
  let cycleQueue = Promise.resolve();
  let queuedCycles = 0;
  let confirmedThinkingLevel = getKnownThinkingLevel() || '';
  let renderedList;

  function renderThinkingList(selectedLevel) {
    const list = renderThinkingLevelList({
      selectedLevel,
      currentModel: getCurrentModel(),
    });
    if (list !== renderedList) {
      thinkingList.innerHTML = list;
      renderedList = list;
    }
  }

  function openThinkingPopup() {
    thinkingPopup.inert = false;
    thinkingPopup.style.display = 'flex';
    thinkingLabelBtn.setAttribute('aria-expanded', 'true');
    renderThinkingList(getKnownThinkingLevel());
  }

  function closeThinkingPopup() {
    if (thinkingPopup.contains(documentImpl.activeElement))
      thinkingLabelBtn.focus({ preventScroll: true });
    thinkingPopup.inert = true;
    thinkingPopup.style.display = 'none';
    thinkingLabelBtn.setAttribute('aria-expanded', 'false');
  }

  thinkingLabelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (thinkingPopup.style.display !== 'none') closeThinkingPopup();
    else openThinkingPopup();
  });

  thinkingList.addEventListener('click', async (e) => {
    const item = e.target.closest('.thinking-level-item');
    if (!item) return;
    if (item.disabled) return;
    const level = item.dataset.level;
    if (!level) return;
    closeThinkingPopup();
    const gen = ++cycleGeneration;
    const run = async () => {
      try {
        const res = await chatApi.setThinkingLevel(sessionId, level);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'set thinking level failed');
        const effectiveLevel = data.thinkingLevel || level;
        confirmedThinkingLevel = effectiveLevel;
        if (gen !== cycleGeneration) return;
        setKnownThinkingLevel(effectiveLevel);
        setThinkingLabel(effectiveLevel);
      } catch (err) {
        if (gen !== cycleGeneration) return;
        setKnownThinkingLevel(confirmedThinkingLevel);
        setThinkingLabel(confirmedThinkingLevel);
        setChatStatus(err.message || String(err), 'error');
      }
    };
    cycleQueue = cycleQueue.catch(() => {}).then(run);
    await cycleQueue;
  });

  documentImpl.addEventListener(
    'click',
    (e) => {
      if (
        thinkingPopup.style.display !== 'none' &&
        !thinkingPopup.contains(e.target) &&
        !thinkingLabelBtn.contains(e.target)
      ) {
        closeThinkingPopup();
      }
    },
    { signal: scope },
  );
  documentImpl.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && thinkingPopup.style.display !== 'none') closeThinkingPopup();
    },
    { signal: scope },
  );

  // Cycle to the next supported thinking level without opening the popup.
  async function cycleThinkingLevel() {
    const supported = supportedThinkingLevels(getCurrentModel(), THINKING_LEVELS);
    const current = getKnownThinkingLevel() || '';
    const idx = supported.indexOf(current);
    const nextIdx = (idx + 1) % supported.length;
    const next = supported[nextIdx];
    if (!next || next === current) return;

    if (queuedCycles === 0) confirmedThinkingLevel = current;
    queuedCycles++;
    const gen = ++cycleGeneration;
    // Optimistically update local state so rapid Shift+Tab presses cycle through levels.
    setKnownThinkingLevel(next);
    setThinkingLabel(next);

    const run = async () => {
      try {
        if (gen !== cycleGeneration) return; // stale before reaching backend
        const res = await chatApi.setThinkingLevel(sessionId, next);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'set thinking level failed');
        const effectiveLevel = data.thinkingLevel || next;
        confirmedThinkingLevel = effectiveLevel;
        if (gen !== cycleGeneration) return; // stale; a newer cycle has started
        setKnownThinkingLevel(effectiveLevel);
        setThinkingLabel(effectiveLevel);
      } catch (err) {
        if (gen !== cycleGeneration) return; // stale; a newer cycle has started
        // Revert to the last level confirmed by the backend, not an optimistic value.
        setKnownThinkingLevel(confirmedThinkingLevel);
        setThinkingLabel(confirmedThinkingLevel);
        setChatStatus(err.message || String(err), 'error');
      } finally {
        queuedCycles = Math.max(0, queuedCycles - 1);
      }
    };

    // Queue requests so the backend observes the same order as the UI.
    cycleQueue = cycleQueue.catch(() => {}).then(run);
    return cycleQueue;
  }

  const detectedThinkingLevel = detectCurrentThinkingLevel(entries);
  if (detectedThinkingLevel) {
    confirmedThinkingLevel = detectedThinkingLevel;
    setKnownThinkingLevel(detectedThinkingLevel);
    setThinkingLabel(detectedThinkingLevel);
  }

  return {
    open: openThinkingPopup,
    close: closeThinkingPopup,
    cycle: cycleThinkingLevel,
    refresh: () => {
      if (thinkingPopup.style.display === 'none') return;
      if (supportedThinkingLevels(getCurrentModel()).length <= 1) closeThinkingPopup();
      else renderThinkingList(getKnownThinkingLevel());
    },
  };
}

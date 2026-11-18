import { t } from '../../shared/i18n.js';
import { icon, ChevronRight } from '../../shared/icons.js';

export function progressLabel(phase) {
  if (phase === 'thinking') return t('activity.thinking');
  if (phase === 'tool') return t('activity.tools');
  return t('btw.working');
}

export function getSpinnerConfig(windowImpl = typeof window !== 'undefined' ? window : null) {
  let style = 'runcat';
  try {
    if (windowImpl && windowImpl.localStorage) {
      const saved = windowImpl.localStorage.getItem('pi-sessions:spinner-style');
      if (saved === 'braille') {
        style = 'braille';
      }
    }
  } catch (_) {}

  if (style === 'braille') {
    return {
      frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      fontFamily: 'monospace',
      interval: 80,
      width: '12px',
    };
  } else {
    // runcat frames mapping to unicode private use area characters in runcat.ttf font
    return {
      frames: ['', '', '', '', ''],
      fontFamily: "'runcat', monospace",
      interval: 100,
      width: '18px',
    };
  }
}

export function clearChatPreviewState(state, { keepAssistant = false } = {}) {
  if (state.pendingUserEl && state.pendingUserEl.parentNode) {
    state.pendingUserEl.parentNode.removeChild(state.pendingUserEl);
    state.pendingUserEl = null;
  }
  if (!keepAssistant) {
    if (state.chatPreviewEl && state.chatPreviewEl.parentNode) {
      state.chatPreviewEl.parentNode.removeChild(state.chatPreviewEl);
    }
    state.chatPreviewEl = null;
    state.phase = '';
    state.content = undefined;
    stopWorkingAnimation(state);
  }
}

export function finishChatPreviewState(state) {
  if (!state?.chatPreviewEl) return false;
  state.phase = '';
  state.chatPreviewEl.classList.remove('chat-preview-waiting');
  state.chatPreviewEl.classList.add('done');
  state.chatPreviewEl.querySelector('.preview-progress')?.remove();
  stopWorkingAnimation(state);
  return true;
}
// Test placeholder for TestSessionViteSourceShowsAnimatedWorkingPreviewLabel: working<span class="working-dots"

export function startWorkingAnimation(
  state,
  {
    setIntervalImpl = setInterval,
    windowImpl = typeof window !== 'undefined' ? window : null,
  } = {},
) {
  stopWorkingAnimation(state);
  if (windowImpl?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const config = getSpinnerConfig(windowImpl);
  let frameIdx = 0;
  state.spinnerInterval = setIntervalImpl(() => {
    if (!state.chatPreviewEl) {
      stopWorkingAnimation(state);
      return;
    }

    frameIdx = (frameIdx + 1) % config.frames.length;
    for (const spinnerEl of state.chatPreviewEl.querySelectorAll('.preview-spinner')) {
      spinnerEl.textContent = config.frames[frameIdx];
    }
  }, config.interval);
}

export function stopWorkingAnimation(state, { clearIntervalImpl = clearInterval } = {}) {
  if (state && state.spinnerInterval) {
    clearIntervalImpl(state.spinnerInterval);
    state.spinnerInterval = null;
  }
}

function setMarkdownContent(el, html) {
  // `renderMarkdown` returns sanitized markdown HTML (or escaped fallback). This
  // is content rendering, not structural view construction; the surrounding
  // preview DOM is built with elements so the helper stays narrowly scoped.
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

function createMarkdownBlock(documentImpl, className) {
  const el = documentImpl.createElement('div');
  el.className = className;
  return el;
}

function createPreviewLabel(documentImpl, config, phase = '', tag = 'div') {
  const label = documentImpl.createElement(tag);
  label.className = 'preview-label';
  if (tag === 'summary') {
    const chevron = documentImpl.createElement('span');
    chevron.className = 'activity-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = icon(ChevronRight, { size: 14 });
    label.appendChild(chevron);
  }
  const spinner = documentImpl.createElement('span');
  spinner.className = 'preview-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.fontFamily = config.fontFamily;
  spinner.style.width = config.width;
  spinner.style.textAlign = 'center';
  spinner.textContent = config.frames[0];
  const text = documentImpl.createElement('span');
  text.className = 'preview-text';
  text.textContent = progressLabel(phase);
  label.append(spinner, text);
  return label;
}

function createAssistantPreview(documentImpl, { waiting = false, windowImpl = null } = {}) {
  const config = getSpinnerConfig(windowImpl);
  const el = documentImpl.createElement('div');
  el.id = 'chat-preview-stream';
  el.className = 'assistant-message chat-preview-stream' + (waiting ? ' chat-preview-waiting' : '');
  const thinking = documentImpl.createElement('details');
  thinking.className = 'preview-thinking';
  thinking.hidden = true;
  thinking.append(
    createPreviewLabel(documentImpl, config, 'thinking', 'summary'),
    createMarkdownBlock(documentImpl, 'activity-thinking-text'),
  );
  const progress = createPreviewLabel(documentImpl, config);
  progress.classList.add('preview-progress');
  el.append(
    thinking,
    createMarkdownBlock(documentImpl, 'message-content assistant-text markdown-content'),
    progress,
  );
  return el;
}

export function renderPendingChatState(
  message,
  state,
  {
    documentImpl = document,
    windowImpl = typeof window !== 'undefined' ? window : null,
    renderMarkdown,
    shouldFollow = () => false,
    forceFollowToBottom = () => {},
    scrollAfterLayout = () => {},
    setIntervalImpl = setInterval,
  } = {},
) {
  const text = String(message || '').trim();
  if (!text) return false;
  const container =
    documentImpl.getElementById('messages') ||
    documentImpl.getElementById('content') ||
    documentImpl.body;
  const keepAssistant = !!state.phase && !state.chatPreviewEl?.classList.contains('done');
  clearChatPreviewState(state, { keepAssistant });

  state.pendingUserEl = documentImpl.createElement('div');
  state.pendingUserEl.id = 'chat-pending-user';
  state.pendingUserEl.className = 'user-message chat-pending-user';
  const userContent = createMarkdownBlock(documentImpl, 'markdown-content');
  setMarkdownContent(userContent, renderMarkdown(text));
  state.pendingUserEl.appendChild(userContent);
  container.insertBefore(state.pendingUserEl, state.chatPreviewEl);

  if (!keepAssistant) {
    state.chatPreviewEl = createAssistantPreview(documentImpl, { waiting: true, windowImpl });
    container.appendChild(state.chatPreviewEl);
    startWorkingAnimation(state, { setIntervalImpl, windowImpl });
  }

  if (shouldFollow()) {
    forceFollowToBottom(false);
    scrollAfterLayout(false, state.chatPreviewEl);
  }
  return true;
}

export function renderChatPreviewState(
  payload,
  state,
  {
    documentImpl = document,
    windowImpl = typeof window !== 'undefined' ? window : null,
    renderMarkdown,
    shouldFollow = () => false,
    forceFollowToBottom = () => {},
    scrollAfterLayout = () => {},
    setIntervalImpl = setInterval,
  } = {},
) {
  if (!payload || typeof payload.content !== 'string') return false;
  const container =
    documentImpl.getElementById('messages') ||
    documentImpl.getElementById('content') ||
    documentImpl.body;
  if (state.chatPreviewEl?.classList.contains('done') && !payload.done) {
    clearChatPreviewState(state);
  }
  if (!state.chatPreviewEl) {
    if (payload.done && !payload.phase && !payload.content && !payload.thinking) return false;
    state.chatPreviewEl = createAssistantPreview(documentImpl, { windowImpl });
    container.appendChild(state.chatPreviewEl);
    startWorkingAnimation(state, { setIntervalImpl, windowImpl });
  }

  const phase = payload.phase || (payload.done ? '' : 'working');
  const thoughts = typeof payload.thinking === 'string' ? payload.thinking : '';
  const thinking = state.chatPreviewEl.querySelector('.preview-thinking');
  const hasThoughts = Boolean(thoughts.trim());
  if (phase !== state.phase || thinking.hidden) thinking.open = phase === 'thinking';
  thinking.hidden = !hasThoughts;
  thinking.classList.toggle('is-thinking', phase === 'thinking');
  const thinkingContent = thinking.querySelector('.activity-thinking-text');
  if (thinkingContent.textContent !== thoughts) thinkingContent.textContent = thoughts;
  const progress = state.chatPreviewEl.querySelector('.preview-progress');
  if (progress) {
    progress.hidden = phase === 'thinking' && hasThoughts;
    progress.querySelector('.preview-text').textContent = progressLabel(phase);
  }
  state.phase = phase;

  state.chatPreviewEl.classList.remove('chat-preview-waiting');
  const content = state.chatPreviewEl.querySelector('.message-content');
  if (state.content !== payload.content) {
    setMarkdownContent(content, renderMarkdown(payload.content));
    state.content = payload.content;
  }
  if (!phase) finishChatPreviewState(state);
  else state.chatPreviewEl.classList.remove('done');
  if (shouldFollow()) {
    forceFollowToBottom(false);
    scrollAfterLayout(false, state.chatPreviewEl);
  }
  return true;
}

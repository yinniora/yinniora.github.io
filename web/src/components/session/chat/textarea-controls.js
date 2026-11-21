import { matchesAction } from '../../../shared/keybindings.js';

export function setupTextareaControls({
  windowImpl = window,
  textarea,
  shell,
  form,
  isMobileTextInputMode = () => false,
  getSlashSelector = () => null,
  getMentionSelector = () => null,
  getThinkingSelector = () => null,
  getModelSelector = () => null,
  updateSendEnabled = () => {},
  updateComposerHeight = () => {},
} = {}) {
  let resizeFrame = null;
  let disposed = false;

  function resize(forceComposerMeasure = false) {
    if (disposed || !textarea || shell?.classList.contains('expanded')) return;
    const previousHeight = textarea.style.height;
    textarea.style.height = 'auto';
    const cs = windowImpl.getComputedStyle(textarea);
    const max = parseFloat(cs.maxHeight) || 200;
    const min = parseFloat(cs.minHeight) || 48;
    const nextHeight = `${Math.max(min, Math.min(textarea.scrollHeight, max))}px`;
    textarea.style.height = nextHeight;
    if (forceComposerMeasure || previousHeight !== nextHeight) updateComposerHeight();
  }

  function cancelResize() {
    if (resizeFrame === null) return;
    windowImpl.cancelAnimationFrame?.(resizeFrame);
    resizeFrame = null;
  }

  function autoResize() {
    cancelResize();
    // Explicit updates can change the form size without changing the textarea.
    resize(true);
  }

  const onInput = () => {
    updateSendEnabled();
    if (resizeFrame !== null) return;
    if (!windowImpl.requestAnimationFrame) {
      resize();
      return;
    }
    resizeFrame = windowImpl.requestAnimationFrame(() => {
      resizeFrame = null;
      resize();
    });
  };

  const onKeydown = (event) => {
    if (getSlashSelector()?.handleKeydown?.(event)) return;
    if (getMentionSelector()?.handleKeydown?.(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      if (isMobileTextInputMode()) return;
      event.preventDefault();
      form?.requestSubmit?.();
    }
    if (matchesAction('cycle-thinking-level', event)) {
      event.preventDefault();
      getThinkingSelector()?.cycle?.();
    }
    if (matchesAction('open-model-selector', event)) {
      event.preventDefault();
      getModelSelector()?.open?.();
    }
  };

  if (textarea) {
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('keydown', onKeydown);
    autoResize();
  }
  updateSendEnabled();

  return {
    autoResize,
    dispose: () => {
      disposed = true;
      cancelResize();
      textarea?.removeEventListener('input', onInput);
      textarea?.removeEventListener('keydown', onKeydown);
    },
  };
}

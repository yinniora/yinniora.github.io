export function setupComposerHeightVar({
  documentImpl = document,
  windowImpl = window,
  form,
  ResizeObserverImpl = windowImpl.ResizeObserver,
} = {}) {
  if (!form) return { update: () => {} };
  let active = true;

  function update() {
    if (!active) return;
    const height = Math.ceil(form.getBoundingClientRect().height || 0);
    documentImpl.documentElement.style.setProperty('--pi-chat-composer-height', `${height}px`);
  }

  update();
  windowImpl.addEventListener('resize', update, { passive: true });
  const observer = ResizeObserverImpl ? new ResizeObserverImpl(update) : null;
  observer?.observe(form);

  return {
    update,
    dispose: () => {
      active = false;
      windowImpl.removeEventListener('resize', update);
      observer?.disconnect();
      documentImpl.documentElement.style.removeProperty('--pi-chat-composer-height');
    },
  };
}

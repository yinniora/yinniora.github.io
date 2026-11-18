const viewportTrackers = new WeakMap();
const zoomLocks = new WeakMap();

export function isTextEditor(element) {
  return (
    element?.matches(
      'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type]), input:is([type="text"], [type="search"], [type="url"], [type="email"], [type="password"], [type="tel"], [type="number"])',
    ) &&
    !element.readOnly &&
    !element.disabled
  );
}

// Fit the shell to the visible keyboard boundary in one step. WebKit may
// resize both viewports and leave an additional document scroll from focusing.
export function trackVisualViewport({ windowImpl = window, documentImpl = document } = {}) {
  if (viewportTrackers.has(documentImpl)) return () => {};
  const viewport = windowImpl.visualViewport;
  const style = documentImpl.documentElement.style;
  const installedIOS =
    windowImpl.navigator?.standalone ||
    (/iPhone|iPad|iPod/.test(windowImpl.navigator?.userAgent || '') &&
      windowImpl.matchMedia?.('(display-mode: standalone)').matches);
  const history = installedIOS ? windowImpl.history : null;
  const originalRestoration = history?.scrollRestoration;
  if (originalRestoration) history.scrollRestoration = 'manual';
  let resetAtHeight = null;
  let frame = 0;
  let restingHeight = windowImpl.innerHeight;
  let width = windowImpl.innerWidth;
  const update = () => {
    frame = 0;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const layoutHeight = windowImpl.innerHeight;
    if (!Number.isFinite(layoutHeight) || layoutHeight < 1) return;
    const editor = documentImpl.activeElement;
    const editing = isTextEditor(editor);
    if (!editing || width !== windowImpl.innerWidth) restingHeight = layoutHeight;
    width = windowImpl.innerWidth;
    const reportedHeight = viewport?.height;
    const visibleHeight =
      reportedHeight >= Math.min(120, layoutHeight)
        ? Math.min(layoutHeight, reportedHeight)
        : layoutHeight;
    const keyboardOpen =
      editing && (restingHeight - layoutHeight > 100 || layoutHeight - visibleHeight > 100);
    const height = Math.floor(keyboardOpen ? visibleHeight : layoutHeight);
    style.setProperty('--pi-visual-height', `${height}px`);
    documentImpl.documentElement.classList.toggle('pi-keyboard-open', Boolean(keyboardOpen));

    if (!installedIOS || !viewport) return;
    const stalePan =
      !keyboardOpen &&
      Math.abs(reportedHeight - layoutHeight) < 32 &&
      viewport.offsetTop >= layoutHeight - 32;
    const root = documentImpl.scrollingElement;
    const composerPan =
      keyboardOpen &&
      editor.closest('#pi-chat-composer, .pi-btw-window') &&
      ((root?.scrollTop || 0) > 1 || viewport.offsetTop > 48);
    if (!stalePan && !composerPan) {
      resetAtHeight = null;
    } else if (resetAtHeight === null || Math.abs(height - resetAtHeight) >= 8) {
      // Setting the shell height first lets the input fit before undoing
      // iOS's document scroll. Avoid repeated resets at the same size.
      resetAtHeight = height;
      if (root?.scrollTop) root.scrollTop = 0;
      windowImpl.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  };
  const schedule = () => {
    if (!frame) frame = windowImpl.requestAnimationFrame(update);
  };
  viewport?.addEventListener('resize', schedule);
  if (installedIOS) viewport?.addEventListener('scroll', schedule);
  windowImpl.addEventListener('resize', schedule);
  windowImpl.addEventListener('popstate', schedule);
  windowImpl.addEventListener('pageshow', schedule);
  documentImpl.addEventListener('focusin', schedule);
  documentImpl.addEventListener('focusout', schedule);
  documentImpl.addEventListener('visibilitychange', schedule);
  update();
  const dispose = () => {
    viewportTrackers.delete(documentImpl);
    viewport?.removeEventListener('resize', schedule);
    if (installedIOS) viewport?.removeEventListener('scroll', schedule);
    if (originalRestoration) history.scrollRestoration = originalRestoration;
    windowImpl.removeEventListener('resize', schedule);
    windowImpl.removeEventListener('popstate', schedule);
    windowImpl.removeEventListener('pageshow', schedule);
    documentImpl.removeEventListener('focusin', schedule);
    documentImpl.removeEventListener('focusout', schedule);
    documentImpl.removeEventListener('visibilitychange', schedule);
    windowImpl.cancelAnimationFrame(frame);
    style.removeProperty('--pi-visual-height');
    documentImpl.documentElement.classList.remove('pi-keyboard-open');
  };
  viewportTrackers.set(documentImpl, dispose);
  return dispose;
}

export function lockPageZoom({ windowImpl = window, documentImpl = document } = {}) {
  if (zoomLocks.has(documentImpl)) return () => {};
  const mobile = () => !!windowImpl.matchMedia?.('(max-width: 900px), (pointer: coarse)').matches;
  const preventGesture = (event) => {
    if (mobile() && event.cancelable) event.preventDefault();
  };
  const options = { passive: false };
  // WebKit exposes zoom gestures separately. Ordinary touches and taps never
  // go through a document-level cancelable handler.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend'])
    documentImpl.addEventListener(name, preventGesture, options);
  const dispose = () => {
    for (const name of ['gesturestart', 'gesturechange', 'gestureend'])
      documentImpl.removeEventListener(name, preventGesture, options);
    zoomLocks.delete(documentImpl);
  };
  zoomLocks.set(documentImpl, dispose);
  return dispose;
}

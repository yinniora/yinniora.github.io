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

// A resize of the layout viewport already accounts for the keyboard. Only
// fall back to the visual viewport on browsers where the keyboard overlays it.
export function trackVisualViewport({ windowImpl = window, documentImpl = document } = {}) {
  if (viewportTrackers.has(documentImpl)) return () => {};
  const viewport = windowImpl.visualViewport;
  const style = documentImpl.documentElement.style;
  let frame = 0;
  let restingHeight = windowImpl.innerHeight;
  let width = windowImpl.innerWidth;
  const update = () => {
    frame = 0;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const layoutHeight = windowImpl.innerHeight;
    if (!Number.isFinite(layoutHeight) || layoutHeight < 1) return;
    const editing = isTextEditor(documentImpl.activeElement);
    if (!editing || width !== windowImpl.innerWidth) restingHeight = layoutHeight;
    width = windowImpl.innerWidth;
    const reportedHeight = viewport?.height;
    const layoutAlreadyResized = restingHeight - layoutHeight > 100;
    const overlay =
      editing &&
      !layoutAlreadyResized &&
      reportedHeight >= Math.min(120, layoutHeight) &&
      layoutHeight - reportedHeight > 100;
    const height = overlay ? reportedHeight : layoutHeight;
    style.setProperty('--pi-visual-height', `${height}px`);
    documentImpl.documentElement.classList.toggle(
      'pi-keyboard-open',
      Boolean(editing && (layoutAlreadyResized || overlay)),
    );
  };
  const schedule = () => {
    if (!frame) frame = windowImpl.requestAnimationFrame(update);
  };
  viewport?.addEventListener('resize', schedule);
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

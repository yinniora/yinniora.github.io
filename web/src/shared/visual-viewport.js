const viewportTrackers = new WeakMap();
const zoomLocks = new WeakMap();

// One viewport for the whole mobile UI: header, content, composer and sheets.
// Ignore page pinch zoom so an enlarged image does not relayout the application.
export function trackVisualViewport({ windowImpl = window, documentImpl = document } = {}) {
  if (viewportTrackers.has(documentImpl)) return () => {};
  const viewport = windowImpl.visualViewport;
  const style = documentImpl.documentElement.style;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    style.setProperty('--pi-visual-height', `${viewport?.height || windowImpl.innerHeight}px`);
    style.setProperty('--pi-visual-top', `${Math.max(0, viewport?.offsetTop || 0)}px`);
    const keyboard = windowImpl.innerHeight - (viewport?.height || windowImpl.innerHeight) > 120;
    documentImpl.documentElement.classList.toggle('pi-keyboard-open', keyboard);
  };
  const schedule = () => {
    if (!frame) frame = windowImpl.requestAnimationFrame(update);
  };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  windowImpl.addEventListener('resize', schedule);
  update();
  const dispose = () => {
    viewportTrackers.delete(documentImpl);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    windowImpl.removeEventListener('resize', schedule);
    windowImpl.cancelAnimationFrame(frame);
    for (const name of ['--pi-visual-height', '--pi-visual-top']) style.removeProperty(name);
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
  const preventPinch = (event) => {
    if (event.touches?.length > 1) preventGesture(event);
  };
  const preventDoubleTap = (event) => {
    if (!event.target?.closest?.('input, textarea, [contenteditable="true"]'))
      preventGesture(event);
  };
  const options = { passive: false };
  for (const name of ['gesturestart', 'gesturechange', 'gestureend'])
    documentImpl.addEventListener(name, preventGesture, options);
  for (const name of ['touchstart', 'touchmove'])
    documentImpl.addEventListener(name, preventPinch, options);
  documentImpl.addEventListener('dblclick', preventDoubleTap, options);
  const dispose = () => {
    for (const name of ['gesturestart', 'gesturechange', 'gestureend'])
      documentImpl.removeEventListener(name, preventGesture);
    for (const name of ['touchstart', 'touchmove'])
      documentImpl.removeEventListener(name, preventPinch);
    documentImpl.removeEventListener('dblclick', preventDoubleTap);
    zoomLocks.delete(documentImpl);
  };
  zoomLocks.set(documentImpl, dispose);
  return dispose;
}

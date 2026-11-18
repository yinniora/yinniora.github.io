import { isTextEditor } from './visual-viewport.js';

const CONTROLS =
  'a[href], button, summary, [role="button"], [role="menuitem"], textarea, input, [contenteditable="true"]';
const TAP_RADIUS = 12;
const NATIVE_CLICK_WAIT = 360;

export function recoverStandaloneTaps({ windowImpl = window, documentImpl = document } = {}) {
  const platform = windowImpl.navigator;
  const isInstalled =
    platform.standalone ||
    (/iPhone|iPad|iPod/.test(platform.userAgent) &&
      windowImpl.matchMedia('(display-mode: standalone)').matches);
  if (!isInstalled) return () => {};

  let touch;
  let timer;
  let replayed;
  const lifetime = new AbortController();

  function controlAt(node) {
    const element = node?.closest?.(CONTROLS);
    if (
      !element ||
      !element.closest('#spa-root, .pi-btw-window, #remote-status') ||
      element.closest('[inert], [aria-disabled="true"]') ||
      element.matches(':disabled')
    ) {
      return null;
    }
    // Keep file pickers, native selects, sliders and other special inputs native.
    if (
      element.matches('input') &&
      !isTextEditor(element) &&
      !element.matches('input[type="checkbox"], input[type="radio"]')
    ) {
      return null;
    }
    return element;
  }

  function cancelPendingClick() {
    windowImpl.clearTimeout(timer);
    timer = undefined;
  }

  function begin(event) {
    cancelPendingClick();
    touch = undefined;
    replayed = undefined;
    if (!event.isTrusted || event.defaultPrevented || event.touches.length !== 1) return;
    const element = controlAt(event.target);
    if (!element) return;
    const point = event.touches[0];
    touch = {
      element,
      x: point.clientX,
      y: point.clientY,
      id: point.identifier,
      at: event.timeStamp,
    };
  }

  function moved(point, start) {
    return (
      point?.identifier !== start.id ||
      Math.hypot(point.clientX - start.x, point.clientY - start.y) > TAP_RADIUS
    );
  }

  function move(event) {
    if (touch && (event.touches.length !== 1 || moved(event.touches[0], touch))) touch = undefined;
  }

  function end(event) {
    const start = touch;
    touch = undefined;
    if (!start || !event.isTrusted || event.defaultPrevented || event.touches.length) return;
    if (event.timeStamp - start.at > 500 || documentImpl.getSelection()?.type === 'Range') return;
    const point = event.changedTouches[0];
    if (moved(point, start)) return;
    const { clientX: x, clientY: y } = point;
    const target = start.element;
    const sameControl = () => controlAt(documentImpl.elementFromPoint(x, y)) === target;
    if (!sameControl()) return;

    if (isTextEditor(target)) {
      // iOS can open the keyboard only while handling the user's touch.
      if (documentImpl.activeElement !== target) target.focus({ preventScroll: true });
      return;
    }

    // Preserve a native click whenever WebKit supplies one. Recover only an
    // unmatched tap with the same visible hit target after the click window.
    timer = windowImpl.setTimeout(() => {
      timer = undefined;
      if (!sameControl() || typeof target.click !== 'function') return;
      replayed = { target, x, y, until: windowImpl.performance.now() + NATIVE_CLICK_WAIT };
      target.click();
    }, NATIVE_CLICK_WAIT);
  }

  function nativeClick(event) {
    if (!event.isTrusted) return;
    cancelPendingClick();
    if (
      replayed &&
      event.detail > 0 &&
      windowImpl.performance.now() < replayed.until &&
      controlAt(event.target) === replayed.target &&
      Math.hypot(event.clientX - replayed.x, event.clientY - replayed.y) <= TAP_RADIUS
    ) {
      replayed = undefined;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function reset() {
    touch = undefined;
    replayed = undefined;
    cancelPendingClick();
  }

  const capture = { capture: true, signal: lifetime.signal };
  const passive = { ...capture, passive: true };
  documentImpl.addEventListener('touchstart', begin, passive);
  documentImpl.addEventListener('touchmove', move, passive);
  documentImpl.addEventListener('touchend', end, passive);
  documentImpl.addEventListener('touchcancel', reset, passive);
  documentImpl.addEventListener('click', nativeClick, capture);
  documentImpl.addEventListener('visibilitychange', reset, capture);
  windowImpl.addEventListener('pagehide', reset, capture);
  return () => {
    reset();
    lifetime.abort();
  };
}

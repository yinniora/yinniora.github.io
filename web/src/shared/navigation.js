import { tick } from 'svelte';

function resolveWindow(windowImpl) {
  return windowImpl ?? (typeof window !== 'undefined' ? window : undefined);
}

function notify(win, direction) {
  if (!win.dispatchEvent) return;
  const event =
    direction && win.CustomEvent
      ? new win.CustomEvent('pi:locationchange', { detail: { direction } })
      : new win.Event('pi:locationchange');
  win.dispatchEvent(event);
}

let activeTransition = null;

function motionAllowed(win, direction) {
  const doc = win?.document;
  return (
    (direction === 'forward' || direction === 'back') &&
    typeof doc?.startViewTransition === 'function' &&
    !doc.hidden &&
    !doc.documentElement.classList.contains('pi-keyboard-open') &&
    !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

// Animate a route change: the old page slides away while the new one slides
// in (push for "forward", pop for "back"). `update` must change the DOM state;
// Svelte flushes it before the new snapshot is taken.
export function withPageTransition(direction, update, { windowImpl } = {}) {
  const win = resolveWindow(windowImpl);
  if (!motionAllowed(win, direction)) {
    update();
    return;
  }
  const root = win.document.documentElement;
  activeTransition?.skipTransition?.();
  root.dataset.navMotion = direction;
  let transition;
  try {
    transition = win.document.startViewTransition(async () => {
      root.dataset.navMotion = direction;
      update();
      await tick();
    });
  } catch {
    delete root.dataset.navMotion;
    update();
    return;
  }
  activeTransition = transition;
  transition.ready?.catch?.(() => {});
  transition.finished?.finally?.(() => {
    if (activeTransition !== transition) return;
    activeTransition = null;
    delete root.dataset.navMotion;
  });
}

export function navigate(
  url,
  { windowImpl, state, direction = url === '/' ? 'back' : 'forward' } = {},
) {
  const win = resolveWindow(windowImpl);
  if (!url || !win) return;
  // Installed apps use the visible Home and Back controls. Keep one document
  // entry so a system edge gesture has no app-created history to traverse.
  if (win.navigator?.standalone || win.matchMedia?.('(display-mode: standalone)').matches) {
    win.history.replaceState(state || {}, '', url);
  } else {
    win.history.pushState(state || {}, '', url);
  }
  // The URL updates at once; the page swap is animated when supported.
  withPageTransition(direction, () => notify(win, direction), { windowImpl: win });
}

export function replaceLocation(url, { windowImpl, direction } = {}) {
  const win = resolveWindow(windowImpl);
  if (!win) return;
  win.history.replaceState(win.history.state, '', url);
  notify(win, direction);
}

export function handleNavClick(event, url, options) {
  if (!url || !event || event.defaultPrevented) return;
  if (typeof event.button === 'number' && event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(url, options);
  return true;
}

// A page with several entry points can return to its originating route.
export function backState({ windowImpl } = {}) {
  const win = resolveWindow(windowImpl);
  if (!win) return {};
  return { back: win.location.pathname + win.location.search };
}

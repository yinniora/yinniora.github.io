// The installed app mirrors its current route in the address without building
// browser history entries. Browser tabs still use ordinary session history.
const installedRoutes = new WeakMap();
const MAX_ROUTES = 64;

function resolveWindow(windowImpl) {
  return windowImpl ?? (typeof window !== 'undefined' ? window : undefined);
}

function notify(win) {
  if (win.dispatchEvent) win.dispatchEvent(new win.Event('pi:locationchange'));
}

export function setupInstalledNavigation({ windowImpl = window, documentImpl = document } = {}) {
  const win = windowImpl;
  if (!win.navigator?.standalone && !win.matchMedia?.('(display-mode: standalone)').matches)
    return () => {};

  const stack = [{ url: win.location.href, state: win.history.state }];
  const routes = { stack, index: 0 };
  installedRoutes.set(win, routes);
  let swipe = null;

  function withinOverlay(target) {
    return (
      target?.closest?.(
        'input, textarea, select, [contenteditable], [aria-modal="true"], pre, video',
      ) ||
      documentImpl.body?.matches('.pi-sheet-open, .modal-sheet-open') ||
      documentImpl.querySelector('dialog[open], .pi-btw-window:not([hidden])')
    );
  }

  function begin(event) {
    swipe = null;
    if (event.touches.length !== 1 || withinOverlay(event.target)) return;
    const touch = event.touches[0];
    const direction = touch.clientX < 28 ? -1 : touch.clientX > win.innerWidth - 28 ? 1 : 0;
    if (!direction) return;
    swipe = { x: touch.clientX, y: touch.clientY, id: touch.identifier, direction };
  }

  function move(event) {
    if (!swipe) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== swipe.id) {
      swipe = null;
      return;
    }
    const dx = (swipe.x - touch.clientX) * swipe.direction;
    const dy = Math.abs(touch.clientY - swipe.y);
    if (dy > 18 && dy >= dx) swipe = null;
    else if (dx > 12 && event.cancelable) event.preventDefault();
  }

  function end(event) {
    if (!swipe) return;
    const { x, y, id, direction } = swipe;
    swipe = null;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === id);
    if (!touch) return;
    const dx = (x - touch.clientX) * direction;
    if (dx < 64 || dx < 1.5 * Math.abs(touch.clientY - y)) return;
    if (event.cancelable) event.preventDefault();
    showInstalledRoute(win, routes, routes.index + direction);
  }

  const cancel = () => (swipe = null);
  function restore() {
    // Ignore native same-document entries left over from earlier app versions.
    const entry = stack[routes.index];
    win.history.replaceState(entry.state, '', entry.url);
    cancel();
  }
  documentImpl.addEventListener('touchstart', begin, { passive: true });
  documentImpl.addEventListener('touchmove', move, { passive: false });
  documentImpl.addEventListener('touchend', end, { passive: false });
  documentImpl.addEventListener('touchcancel', cancel);
  win.addEventListener('popstate', restore);
  win.addEventListener('pagehide', cancel);
  return () => {
    installedRoutes.delete(win);
    documentImpl.removeEventListener('touchstart', begin);
    documentImpl.removeEventListener('touchmove', move);
    documentImpl.removeEventListener('touchend', end);
    documentImpl.removeEventListener('touchcancel', cancel);
    win.removeEventListener('popstate', restore);
    win.removeEventListener('pagehide', cancel);
  };
}

function showInstalledRoute(win, routes, index) {
  const entry = routes.stack[index];
  if (!entry) return;
  win.history.replaceState(entry.state, '', entry.url);
  routes.index = index;
  notify(win);
}

export function navigate(url, { windowImpl, state, back = false } = {}) {
  const win = resolveWindow(windowImpl);
  if (!url || !win) return;
  const routes = installedRoutes.get(win);
  if (!routes) {
    win.history.pushState(state || {}, '', url);
    notify(win);
    return;
  }
  const target = new URL(url, win.location.href).href;
  if (target === routes.stack[routes.index].url) return;
  if (back && target === routes.stack[routes.index - 1]?.url) {
    showInstalledRoute(win, routes, routes.index - 1);
    return;
  }
  routes.stack.splice(routes.index + 1, routes.stack.length, { url: target, state: state || {} });
  if (routes.stack.length > MAX_ROUTES) routes.stack.shift();
  showInstalledRoute(win, routes, routes.stack.length - 1);
}

export function replaceLocation(url, { windowImpl } = {}) {
  const win = resolveWindow(windowImpl);
  if (!win) return;
  win.history.replaceState(win.history.state, '', url);
  const routes = installedRoutes.get(win);
  if (routes) routes.stack[routes.index].url = win.location.href;
  notify(win);
}

export function handleNavClick(event, url, options) {
  if (!url || !event || event.defaultPrevented) return;
  if (typeof event.button === 'number' && event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(url, options);
}

// A page with several entry points can return to its originating route.
export function backState({ windowImpl } = {}) {
  const win = resolveWindow(windowImpl);
  if (!win) return {};
  return { back: win.location.pathname + win.location.search };
}

function resolveWindow(windowImpl) {
  return windowImpl ?? (typeof window !== 'undefined' ? window : undefined);
}

function notify(win) {
  if (win.dispatchEvent) win.dispatchEvent(new win.Event('pi:locationchange'));
}

export function navigate(url, { windowImpl, state } = {}) {
  const win = resolveWindow(windowImpl);
  if (!url || !win) return;
  // Installed apps use the visible Home and Back controls. Keep one document
  // entry so a system edge gesture has no app-created history to traverse.
  if (win.navigator?.standalone || win.matchMedia?.('(display-mode: standalone)').matches) {
    win.history.replaceState(state || {}, '', url);
  } else {
    win.history.pushState(state || {}, '', url);
  }
  notify(win);
}

export function replaceLocation(url, { windowImpl } = {}) {
  const win = resolveWindow(windowImpl);
  if (!win) return;
  win.history.replaceState(win.history.state, '', url);
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

// Manually enabled from the Mac. Counters and hit targets stay on this device.
export function showTapDiagnostics() {
  const panel = document.createElement('output');
  panel.id = 'pi-tap-diagnostics';
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = [
    'position:fixed',
    'left:6px',
    'right:6px',
    'bottom:calc(env(safe-area-inset-bottom) + 3px)',
    'z-index:2147483647',
    'background:#16181d',
    'color:#fff',
    'padding:4px 6px',
    'font:11px/1.4 monospace',
    'white-space:pre-line',
    'pointer-events:none',
  ].join(';');
  document.body.append(panel);

  const events = {
    touchstart: 0,
    touchend: 0,
    touchcancel: 0,
    pointerdown: 0,
    pointerup: 0,
    click: 0,
    focusin: 0,
    scroll: 0,
  };
  const controls = [
    ['H', '.session-header-back'],
    ['B', '#pi-btw-button'],
    ['I', '#pi-chat-message'],
    ['M', '#web-menu-btn'],
  ];
  const start = performance.now();
  let last = '—';
  let synthetic = 0;
  let errors = 0;

  function labelFor(node) {
    for (const [label, selector] of controls) {
      if (node?.closest?.(selector)) return label;
    }
    if (node?.closest?.('dialog[open], [aria-modal="true"]')) return 'dialog';
    if (node?.closest?.('#content')) return 'transcript';
    if (node?.closest?.('#spa-root')) return 'workspace';
    if (node === document.body) return 'body';
    if (node === document.documentElement) return 'html';
    if (node === document) return 'document';
    return node ? 'outside' : 'none';
  }

  const lifetime = new AbortController();
  for (const type of Object.keys(events)) {
    document.addEventListener(
      type,
      (event) => {
        if (type === 'click' && !event.isTrusted) synthetic++;
        else events[type]++;
        if (type !== 'scroll') {
          const point = event.changedTouches?.[0] || event;
          const hit = Number.isFinite(point.clientX)
            ? labelFor(document.elementFromPoint(point.clientX, point.clientY))
            : '—';
          const pointLabel = Number.isFinite(point.clientX)
            ? `@${Math.round(point.clientX)},${Math.round(point.clientY)}`
            : '';
          last = type + '/' + labelFor(event.target) + '→' + hit + pointLabel;
        }
      },
      { capture: true, passive: true, signal: lifetime.signal },
    );
  }
  const countError = () => errors++;
  window.addEventListener('error', countError, { signal: lifetime.signal });
  window.addEventListener('unhandledrejection', countError, { signal: lifetime.signal });

  function refresh() {
    const hit = controls
      .map(([label, selector]) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        if (!box?.width || !box.height) return '';
        return (
          label +
          ':' +
          labelFor(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        );
      })
      .filter(Boolean)
      .join(' ');
    const elapsed = Math.floor((performance.now() - start) / 1000);
    const { touchstart, touchend, touchcancel, pointerdown, pointerup, click, focusin, scroll } =
      events;
    const { width, height, offsetTop } = window.visualViewport || {};
    const dim = `${innerWidth}×${innerHeight} / ${Math.round(width || 0)}×${Math.round(height || 0)}+${Math.round(offsetTop || 0)}`;
    panel.value = `Touch ${touchstart}/${touchend}/${touchcancel} · Pointer ${pointerdown}/${pointerup} · Click ${click}+${synthetic} · Focus ${focusin}\nScroll ${scroll} · JS ${elapsed}s · Error ${errors} · ${last}\nHit ${hit || '—'} · ${dim}`;
  }
  refresh();
  const interval = setInterval(refresh, 500);
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.persisted) return;
      clearInterval(interval);
      lifetime.abort();
      panel.remove();
    },
    { signal: lifetime.signal },
  );
}

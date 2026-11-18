const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], pre, code, table, video, audio, img';

export function setupSwipeBack(
  content,
  { onBack, enabled, startOnControl = '', documentImpl = document },
) {
  let start = null;

  function blocked() {
    return (
      documentImpl.documentElement.classList.contains('pi-keyboard-open') ||
      documentImpl.body.matches('.pi-sheet-open, .modal-sheet-open') ||
      documentImpl.querySelector('dialog[open], .pi-btw-window:not([hidden])')
    );
  }

  function begin(event) {
    start = null;
    const control = event.target.closest?.(INTERACTIVE);
    if (
      event.touches.length !== 1 ||
      !enabled() ||
      (control && (!startOnControl || !control.matches(startOnControl))) ||
      blocked()
    )
      return;
    const touch = event.touches[0];
    if (touch.clientX - content.getBoundingClientRect().left > 72) return;
    start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, time: event.timeStamp };
  }

  function move(event) {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id) {
      start = null;
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (dx < -12 || (dy > 24 && dy > dx * 0.6)) start = null;
  }

  function end(event) {
    const gesture = start;
    start = null;
    if (!gesture || event.touches.length || event.timeStamp - gesture.time > 700 || blocked())
      return;
    if (documentImpl.getSelection()?.type === 'Range') return;
    const touch = Array.from(event.changedTouches).find(
      ({ identifier }) => identifier === gesture.id,
    );
    if (!touch) return;
    const dx = touch.clientX - gesture.x;
    const dy = Math.abs(touch.clientY - gesture.y);
    if (dx >= 90 && dx > dy * 1.7 && enabled()) onBack();
  }

  const cancel = () => {
    start = null;
  };
  const listeners = { touchstart: begin, touchmove: move, touchend: end, touchcancel: cancel };
  for (const [type, handler] of Object.entries(listeners)) {
    content.addEventListener(type, handler, { passive: true });
  }
  return () => {
    for (const [type, handler] of Object.entries(listeners)) {
      content.removeEventListener(type, handler);
    }
  };
}

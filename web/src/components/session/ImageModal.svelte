<script>
  import { onMount, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { icon, X, Plus, Minus } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  const ZOOMABLE_SELECTOR =
    '.message-image, .pi-chat-attachment-preview, .assistant-text img, .markdown-content img, .pi-btw-md img';
  let open = $state(false);
  let src = $state(null);
  let alt = $state('');
  let zoom = $state(1);
  let containerEl;
  let imgEl;
  let previousFocus;
  let pointerStart;
  let viewportEl;
  const pointers = new SvelteMap();
  let pinch;
  let gestureMoved = false;

  function startPointer(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.size) {
      pointerStart = { x: event.clientX, y: event.clientY };
      gestureMoved = false;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      (event.target === imgEl ? imgEl : viewportEl).setPointerCapture?.(event.pointerId);
    } catch {}
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const box = viewportEl.getBoundingClientRect();
      pinch = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom,
        x: ((a.x + b.x) / 2 - box.left + viewportEl.scrollLeft) / zoom,
        y: ((a.y + b.y) / 2 - box.top + viewportEl.scrollTop) / zoom,
      };
      gestureMoved = true;
    }
  }

  async function movePointer(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8)
      gestureMoved = true;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const box = viewportEl.getBoundingClientRect();
      zoom = Math.max(
        1,
        Math.min(4, (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance),
      );
      const left = pinch.x * zoom - ((a.x + b.x) / 2 - box.left);
      const top = pinch.y * zoom - ((a.y + b.y) / 2 - box.top);
      event.preventDefault();
      await tick();
      viewportEl.scrollLeft = left;
      viewportEl.scrollTop = top;
    } else if (pointers.size === 1 && zoom > 1) {
      event.preventDefault();
      viewportEl.scrollLeft += previous.x - event.clientX;
      viewportEl.scrollTop += previous.y - event.clientY;
    }
  }

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
  }

  function closeFromBlank(event) {
    const start = pointerStart;
    pointerStart = null;
    if (gestureMoved) return;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    if (event.target !== imgEl) {
      close();
      return;
    }
    if (!imgEl.naturalWidth || !imgEl.naturalHeight) return;
    const box = imgEl.getBoundingClientRect();
    const scale = Math.min(box.width / imgEl.naturalWidth, box.height / imgEl.naturalHeight);
    const width = imgEl.naturalWidth * scale,
      height = imgEl.naturalHeight * scale;
    const left = box.left + (box.width - width) / 2,
      top = box.top + (box.height - height) / 2;
    if (
      event.clientX < left ||
      event.clientX > left + width ||
      event.clientY < top ||
      event.clientY > top + height
    )
      close();
  }

  function show(nextSrc, nextAlt) {
    if (!nextSrc) return;
    previousFocus = document.activeElement;
    src = nextSrc;
    alt = nextAlt || t('media.image');
    zoom = 1;
    pointers.clear();
    pointerStart = null;
    pinch = null;
    gestureMoved = false;
    if (viewportEl) viewportEl.scrollLeft = viewportEl.scrollTop = 0;
    open = true;
    if (!containerEl.open) containerEl.showModal?.();
  }
  function close() {
    open = false;
    pointers.clear();
    pinch = null;
    containerEl?.close?.();
    const exit = containerEl
      ?.getAnimations?.()
      .find((animation) => animation.transitionProperty === 'opacity');
    if (exit) {
      exit.finished
        .catch(() => {})
        .then(() => {
          if (!open) src = null;
        });
    } else src = null;
    previousFocus?.focus?.({ preventScroll: true });
  }

  onMount(() => {
    const onWheel = async (event) => {
      if (!open || !event.ctrlKey) return;
      event.preventDefault();
      const box = viewportEl.getBoundingClientRect();
      const x = event.clientX - box.left,
        y = event.clientY - box.top;
      const anchorX = (viewportEl.scrollLeft + x) / zoom;
      const anchorY = (viewportEl.scrollTop + y) / zoom;
      zoom = Math.max(1, Math.min(4, zoom * Math.exp(-event.deltaY * 0.01)));
      const next = zoom;
      await tick();
      if (!open) return;
      viewportEl.scrollLeft = anchorX * next - x;
      viewportEl.scrollTop = anchorY * next - y;
    };
    viewportEl.addEventListener('wheel', onWheel, { passive: false });
    const onClick = (event) => {
      const image = event.target.closest?.(ZOOMABLE_SELECTOR);
      if (!image || containerEl?.contains(image)) return;
      event.preventDefault();
      show(image.currentSrc || image.src, image.alt);
    };
    const preview = (event) => show(event.detail?.src, event.detail?.alt);
    const onKey = (event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('pi:image-preview', preview);
    return () => {
      viewportEl.removeEventListener('wheel', onWheel);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pi:image-preview', preview);
      containerEl?.close?.();
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<dialog
  id="image-modal"
  class="image-modal"
  class:open
  bind:this={containerEl}
  aria-label={t('media.image')}
  oncancel={close}
  onclick={(event) => {
    if (event.target === containerEl) close();
  }}
  onkeydown={() => {}}
>
  <header class="image-toolbar">
    <span>{alt}</span>
    <button
      disabled={zoom <= 1}
      aria-label={t('media.zoomOut')}
      onclick={() => (zoom = Math.max(1, zoom - 0.5))}>{@html icon(Minus, { size: 20 })}</button
    >
    <button class="image-zoom-reset" aria-label={t('media.resetZoom')} onclick={() => (zoom = 1)}
      >{Math.round(zoom * 100)}%</button
    >
    <button
      disabled={zoom >= 4}
      aria-label={t('media.zoomIn')}
      onclick={() => (zoom = Math.min(4, zoom + 0.5))}>{@html icon(Plus, { size: 20 })}</button
    >
    <button aria-label={t('common.close')} onclick={close}>{@html icon(X, { size: 22 })}</button>
  </header>
  <div
    class="image-viewport"
    bind:this={viewportEl}
    role="presentation"
    onclick={closeFromBlank}
    onpointerdown={startPointer}
    onpointermove={movePointer}
    onpointerup={endPointer}
    onpointercancel={endPointer}
    onlostpointercapture={endPointer}
  >
    <img
      id="modal-image"
      bind:this={imgEl}
      {src}
      {alt}
      draggable={false}
      style:width={`${zoom * 100}%`}
      style:height={`calc(${zoom} * (var(--pi-visual-height, 100dvh) - 100px))`}
    />
  </div>
</dialog>

<style>
  dialog.image-modal {
    position: fixed;
    inset: 0;
    margin: 0;
    padding: 0;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
    color: #f3f3f3;
    background: #111f;
  }
  dialog.image-modal.open {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
  }
  dialog::backdrop {
    background: #111e;
  }
  .image-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    padding: max(8px, env(safe-area-inset-top)) 8px 8px 16px;
    min-height: 60px;
    border-bottom: 1px solid #ffffff26;
  }
  .image-toolbar > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .image-toolbar button {
    display: grid;
    place-items: center;
    flex: none;
    min-width: 40px;
    height: 44px;
    border: 0;
    background: transparent;
    color: inherit;
    border-radius: 10px;
    cursor: pointer;
    font-size: 11px;
  }
  .image-toolbar button:disabled {
    opacity: 0.3;
  }
  .image-toolbar button:hover {
    background: #ffffff15;
  }
  .image-viewport {
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    touch-action: none;
    padding-bottom: env(safe-area-inset-bottom);
  }
  dialog.image-modal img {
    display: block;
    max-width: none;
    max-height: none;
    object-fit: contain;
    margin: 0;
    cursor: default;
  }
  @media (max-width: 900px) {
    dialog.image-modal {
      top: 0;
      bottom: auto;
      height: var(--pi-visual-height, 100dvh);
    }
  }
</style>

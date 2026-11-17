<script>
  import { onMount } from 'svelte';
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

  function closeFromBlank(event) {
    const start = pointerStart;
    pointerStart = null;
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
    open = true;
    if (!containerEl.open) containerEl.showModal?.();
  }
  function close() {
    open = false;
    src = null;
    containerEl?.close?.();
    previousFocus?.focus?.({ preventScroll: true });
  }

  onMount(() => {
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
    role="presentation"
    onclick={closeFromBlank}
    onpointerdown={(event) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    }}
  >
    <img
      id="modal-image"
      bind:this={imgEl}
      {src}
      {alt}
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
    touch-action: pan-x pan-y;
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
      top: var(--pi-visual-top, 0px);
      bottom: auto;
      height: var(--pi-visual-height, 100dvh);
    }
  }
</style>

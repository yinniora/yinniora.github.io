<script>
  // A sheet belongs to the current view and does not add a route.
  import { icon, X } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  let {
    open = $bindable(false),
    title = '',
    showBack = true,
    showClose = true,
    closeOnEscape = true,
    closeOnBackdrop = true,
    onClose = null,
    // Per-modal styling hooks (the former showSheet consumers tagged the
    // backdrop/panel/body with their own classes for CSS).
    backdropClass = '',
    panelClass = '',
    bodyClass = '',
    children,
    // Optional inline controls rendered between the back button and the
    // close-X inside .pi-sheet-header. Lets a sheet host its primary actions
    // in the header bar instead of a second toolbar row underneath — useful
    // on mobile where vertical space is scarce.
    headerExtra = null,
  } = $props();

  let mobile = $state(false);
  let backdropEl = $state(null);
  let panelEl = $state(null);

  function backdropMotion(node) {
    return fade(node, { duration: motionDuration(node, 180) });
  }

  function panelMotion(node) {
    return fly(node, {
      duration: motionDuration(node, 240),
      y: document.documentElement.classList.contains('pi-keyboard-open') ? 0 : mobile ? 22 : 12,
      opacity: 0.7,
      easing: cubicOut,
    });
  }

  function motionDuration(node, duration) {
    if (!node.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
    return duration;
  }

  function onBackdrop(e) {
    if (closeOnBackdrop && e.target === backdropEl) open = false;
  }

  function getFocusable() {
    if (!panelEl) return [];
    return Array.from(
      panelEl.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  function onKey(e) {
    if (closeOnEscape && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      open = false;
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = getFocusable();
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !panelEl.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last || !panelEl.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!open || !backdropEl || !panelEl) return;
    const backdrop = backdropEl;
    const panel = panelEl;
    const previousActive = document.activeElement;
    const isMobile = !!window.matchMedia?.('(max-width: 900px)').matches;
    mobile = isMobile;
    const { body } = document;
    body.dataset.piSheetCount = String(Number(body.dataset.piSheetCount || 0) + 1);
    body.classList.add('pi-sheet-open');
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    if (!isMobile) panel.focus({ preventScroll: true });

    return () => {
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      const count = Number(body.dataset.piSheetCount || 1) - 1;
      if (count > 0) body.dataset.piSheetCount = String(count);
      else {
        delete body.dataset.piSheetCount;
        body.classList.remove('pi-sheet-open');
      }
      if (!open) {
        if (!isMobile && previousActive?.isConnected)
          previousActive.focus?.({ preventScroll: true });
        onClose?.();
      }
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#if open}
  <div
    class="pi-sheet-backdrop open {backdropClass}"
    class:pi-sheet-mobile={mobile}
    bind:this={backdropEl}
    transition:backdropMotion
  >
    <div
      class="pi-sheet-panel open {panelClass}"
      class:pi-sheet-mobile={mobile}
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      transition:panelMotion
    >
      <h2 class="sr-only">{title}</h2>
      <div class="pi-sheet-header">
        {#if showBack}
          <button
            class="pi-sheet-back"
            aria-label={t('common.closeNamed', { name: title })}
            onclick={() => (open = false)}
          >
            <span aria-hidden="true">←</span><span>{title}</span>
          </button>
        {:else}
          <div></div>
        {/if}
        {#if headerExtra}
          <div class="pi-sheet-header-extra">{@render headerExtra()}</div>
        {/if}
        {#if showClose}
          <button
            class="pi-sheet-close-x"
            aria-label={t('common.close')}
            onclick={() => (open = false)}>{@html icon(X, { size: 16 })}</button
          >
        {/if}
      </div>
      <div class="pi-sheet-body {bodyClass}">{@render children?.()}</div>
    </div>
  </div>
{/if}

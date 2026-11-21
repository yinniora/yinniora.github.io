<script>
  import { onMount } from 'svelte';
  import {
    icon,
    Play,
    Pause,
    X,
    CornerDownRight,
    Layers,
    Pencil,
    Send,
    ListPlus,
    Paperclip,
  } from '../../../shared/icons.js';
  import { t } from '../../../shared/i18n.js';

  let { store } = $props();

  // Hide the whole panel when there are no items, so the composer collapses
  // back to its normal height.
  const visible = $derived(store.visibleItems.length > 0);

  // Steers ride the running turn; queued rows wait for it to finish. They are
  // different promises to the user, so they get separate groups and actions.
  // Groups follow the store order (queued first) so ↑/↓ and the visual order
  // agree.
  const queued = $derived(store.visibleItems.filter((item) => item.kind === 'queued'));
  const steers = $derived(store.visibleItems.filter((item) => item.kind === 'steer'));
  const queuedCount = $derived(queued.length);
  const steerCount = $derived(steers.length);
  const indexById = $derived(new Map(store.items.map((item, index) => [item.id, index])));
  const bothKinds = $derived(steerCount > 0 && queuedCount > 0);

  const statusLabel = $derived(
    queuedCount && store.paused
      ? t('composer.queuePaused')
      : bothKinds
        ? t('composer.queueAria')
        : steerCount > 0
          ? t('composer.queueSteeringCount')
          : t('composer.queueActive'),
  );
  const countLabel = $derived(formatCount(queuedCount, steerCount));
  const activeDescendantId = $derived(
    store.items[store.focusIndex]?.kind === 'queued'
      ? `pi-queue-item-${store.items[store.focusIndex].id}`
      : '',
  );

  function formatCount(queuedTotal, steerTotal) {
    if (queuedTotal === 0 && steerTotal === 0) return '';
    if (queuedTotal === 0) return t('composer.steerOnlyHint');
    if (steerTotal === 0) return `${queuedTotal} ${t('composer.queueQueuedCount')}`;
    return `${queuedTotal} ${t('composer.queueQueuedCount')} · ${steerTotal} ${t('composer.steerTag')}`;
  }

  function chipText(item) {
    const raw = (item.displayText || item.text || '').trim();
    return raw || t('composer.attachmentText');
  }

  function onResume() {
    store.actions.resume?.();
  }

  function onPause() {
    store.setPaused(true);
  }

  function onItemClick(item) {
    store.setFocusIndex(indexById.get(item.id) ?? -1);
  }

  function onDelete(item) {
    if (item.kind === 'queued') store.removeById(item.id);
    else if (item.editable) store.actions.withdrawSteer?.(item.id);
  }

  function onEdit(item) {
    if (item.kind === 'steer' && item.editable) store.actions.editSteer?.(item.id);
    else if (item.kind === 'queued') store.actions.edit?.(item.id);
  }

  // Document-level keyboard routing so the shortcuts work from anywhere on the
  // page, without forcing the user to first click the panel.
  //
  // Rule: shortcuts only fire when the textarea is empty (or the focus is not
  // inside any editable field). Once the user starts typing, every key — arrows,
  // backspace, enter, the letter "E" — goes to the textarea unmolested.
  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true;
    return !!target.isContentEditable;
  }

  function shouldHandleShortcut(target, key) {
    if (key === 'Escape') return true;
    const composer = document.getElementById('pi-chat-composer');
    if (target && composer?.contains(target) && target.id === 'pi-chat-message') {
      // Inside the textarea: allow navigation/action keys only when empty.
      return target.value === '';
    }
    // Other focusable inputs (e.g. search) — don't hijack.
    return !isEditableTarget(target);
  }

  function onDocumentKeydown(event) {
    if (!visible) return;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const key = event.key;
    const known =
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === 'Backspace' ||
      key === 'Delete' ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'e' ||
      key === 'E';
    if (!known) return;
    if (
      event.target?.closest?.('button, a, summary, #pi-chat-model-popup') ||
      !shouldHandleShortcut(event.target, key)
    )
      return;

    if (key === 'ArrowDown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      store.focusDown();
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      event.stopImmediatePropagation();
      store.focusUp();
      return;
    }
    if (key === 'Escape') {
      if (!store.focusedItem()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      store.setFocusIndex(-1);
      const textarea = document.getElementById('pi-chat-message');
      textarea?.focus?.();
      return;
    }
    const focused = store.focusedItem();
    if (!focused) return;
    if (key === 'Backspace' || key === 'Delete') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onDelete(focused);
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (focused.kind === 'queued') store.actions.sendNow?.(focused.id);
      else focused.detail?.sendNow?.();
      return;
    }
    if (key === 'e' || key === 'E') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEdit(focused);
    }
  }

  // Auto-focus the head row only on the 0 → N transition so the user can hit
  // ↑↓⌫↩E immediately without an arrow press first. After Esc clears the
  // focus (sets focusIndex to -1) we don't snap back to 0 — the user
  // explicitly left the panel.
  let lastItemCount = 0;
  $effect(() => {
    const items = store.visibleItems;
    if (items.length > 0 && lastItemCount === 0 && !store.focusedItem()) {
      store.setFocusIndex(indexById.get(items[0].id) ?? -1);
    }
    lastItemCount = items.length;
  });

  onMount(() => {
    // capture: true beats textarea-controls.js's own keydown handler, which
    // would otherwise turn Enter into a form-submit before we see it.
    document.addEventListener('keydown', onDocumentKeydown, true);
    return () => document.removeEventListener('keydown', onDocumentKeydown, true);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->
{#if visible}
  <section
    class="pi-queue-panel"
    class:pi-queue-panel--paused={store.paused && queuedCount > 0}
    class:pi-queue-panel--steers={steerCount > 0 && queuedCount === 0}
    aria-label={t('composer.queueAria')}
  >
    <header class="pi-queue-header">
      <div class="pi-queue-status">
        <span class="pi-queue-status-label">{statusLabel}</span>
        {#if countLabel}<span class="pi-queue-status-count"> · {countLabel}</span>{/if}
        {#if store.persistsLocally && queuedCount > 0 && !bothKinds && !store.paused}
          <span
            class="pi-queue-status-saved"
            title={t('composer.queueSavedLocallyHint')}
            aria-label={t('composer.queueSavedLocallyHint')}
          >
            · {t('composer.queueSavedLocally')}</span
          >
        {/if}
      </div>
      <div class="pi-queue-header-actions">
        {#if queuedCount > 0}
          {#if store.paused}
            <button
              type="button"
              class="pi-queue-toggle pi-queue-toggle--resume"
              disabled={store.mutating}
              onclick={onResume}
              title={t('composer.queueResumeHint')}
            >
              {@html icon(Play, { size: 16 })}<span>{t('composer.resume')}</span>
            </button>
          {:else}
            <button
              type="button"
              class="pi-queue-toggle"
              disabled={store.mutating}
              onclick={onPause}
              title={t('composer.queuePauseHint')}
            >
              {@html icon(Pause, { size: 16 })}<span>{t('composer.pause')}</span>
            </button>
          {/if}
        {/if}
      </div>
    </header>

    {#if queued.length > 0}
      <div class="pi-queue-section">
        {#if bothKinds}
          <div class="pi-queue-section-label">{t('composer.queueActive')}</div>
        {/if}
        <ul
          class="pi-queue-list"
          role="listbox"
          tabindex="-1"
          aria-label={t('composer.queueAria')}
          aria-activedescendant={activeDescendantId || undefined}
        >
          {#each queued as item (item.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- Keyboard navigation is handled at the document level. -->
            <li
              id={`pi-queue-item-${item.id}`}
              class="pi-queue-item"
              data-has-attachments={item.hasAttachments || undefined}
              class:pi-queue-item--focused={store.focusIndex === indexById.get(item.id)}
              role="option"
              aria-selected={store.focusIndex === indexById.get(item.id)}
              onclick={() => onItemClick(item)}
              onmousedown={(event) => event.preventDefault()}
            >
              <span class="pi-queue-item-icon" aria-hidden="true">
                {@html icon(item.hasAttachments ? Paperclip : Layers, { size: 16 })}
              </span>
              <span class="pi-queue-item-text">{chipText(item)}</span>
              <span class="pi-queue-item-actions">
                <button
                  type="button"
                  class="pi-queue-item-action"
                  aria-label={t('composer.queueEdit')}
                  title={t('composer.queueEdit')}
                  onclick={(event) => {
                    event.stopPropagation();
                    onEdit(item);
                  }}>{@html icon(Pencil, { size: 16 })}</button
                >
                <button
                  type="button"
                  class="pi-queue-item-action"
                  aria-label={t('composer.queueSendNow')}
                  title={t('composer.queueSendNow')}
                  onclick={(event) => {
                    event.stopPropagation();
                    store.actions.sendNow?.(item.id);
                  }}>{@html icon(Send, { size: 16 })}</button
                >
                <button
                  type="button"
                  class="pi-queue-item-action pi-queue-item-action--withdraw"
                  aria-label={t('composer.removeQueued')}
                  title={t('composer.removeQueued')}
                  onclick={(event) => {
                    event.stopPropagation();
                    onDelete(item);
                  }}>{@html icon(X, { size: 16 })}</button
                >
              </span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if steers.length > 0}
      <div class="pi-queue-section">
        {#if bothKinds}
          <div class="pi-queue-section-label">{t('composer.queueSteeringCount')}</div>
        {/if}
        <ul class="pi-queue-list pi-queue-steer-list" aria-label={t('composer.queueSteeringCount')}>
          {#each steers as item (item.id)}
            <li
              id={`pi-queue-item-${item.id}`}
              class="pi-queue-item pi-queue-item--steer"
              class:pi-queue-item--focused={store.focusIndex === indexById.get(item.id)}
            >
              <span class="pi-queue-item-icon" aria-hidden="true">
                {@html icon(
                  item.hasAttachments || item.detail?.files?.length ? Paperclip : CornerDownRight,
                  { size: 16 },
                )}
              </span>
              <div class="pi-steer-copy">
                <span class="pi-queue-item-text">{chipText(item)}</span>
                <span class="pi-steer-status">{t('composer.steerDraftStatus')}</span>
              </div>
              <button
                type="button"
                class="pi-queue-item-action pi-steer-send"
                onclick={() => item.detail?.sendNow?.()}
              >
                {@html icon(Send, { size: 15 })}<span>{t('composer.steerSendAction')}</span>
              </button>
              <div class="pi-queue-item-actions pi-steer-actions">
                <button
                  type="button"
                  class="pi-queue-item-action"
                  title={t('composer.steerEdit')}
                  onclick={() => onEdit(item)}
                >
                  {@html icon(Pencil, { size: 15 })}<span>{t('composer.steerEditAction')}</span>
                </button>
                <button
                  type="button"
                  class="pi-queue-item-action"
                  title={t('composer.steerToQueue')}
                  onclick={() => store.actions.queueSteer?.(item.id)}
                >
                  {@html icon(ListPlus, { size: 15 })}<span>{t('composer.steerQueueAction')}</span>
                </button>
                <button
                  type="button"
                  class="pi-queue-item-action pi-queue-item-action--withdraw"
                  title={t('composer.steerWithdraw')}
                  onclick={() => onDelete(item)}
                >
                  {@html icon(X, { size: 15 })}<span>{t('composer.steerWithdrawAction')}</span>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if queuedCount > 0}
      <footer class="pi-queue-shortcuts" aria-hidden="true">
        <span class="pi-queue-shortcut"><kbd>↑↓</kbd>{t('composer.queueNavigate')}</span>
        <span class="pi-queue-shortcut"><kbd>E</kbd>{t('composer.queueEdit')}</span>
        <span class="pi-queue-shortcut"><kbd>⌫</kbd>{t('composer.queueDelete')}</span>
        <span class="pi-queue-shortcut"><kbd>↩</kbd>{t('composer.queueSendNow')}</span>
        <span class="pi-queue-shortcut pi-queue-shortcut--right"
          ><kbd>Esc</kbd>{t('composer.queueExit')}</span
        >
      </footer>
    {/if}
  </section>
{/if}

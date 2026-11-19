<script>
  import {
    icon,
    Camera,
    ChevronDown,
    Gauge,
    Paperclip,
    Plus,
    Square,
    Terminal,
  } from '../../../shared/icons.js';
  import { t } from '../../../shared/i18n.js';
  import { supportedThinkingLevels } from '../../../session/chat/chat-selectors.js';
  import { ChatToolbarState } from './chat-toolbar-state.svelte.js';
  import ContextUsage from './ContextUsage.svelte';
  import ComputerPermission from './ComputerPermission.svelte';

  let {
    chatAvailable = true,
    toolbar = new ChatToolbarState(),
    modelLabel = '',
    sessionId = '',
  } = $props();
  let attachMenu = $state(null);

  function chooseAttachment(id) {
    attachMenu.open = false;
    document.getElementById(id)?.click();
  }

  const statusText = $derived(
    toolbar.statusText || (chatAvailable ? t('composer.idle') : t('composer.unavailable')),
  );
  const modelTitle = $derived(
    toolbar.selectedModel?.providerLabel
      ? `${toolbar.selectedModel.providerLabel} · ${toolbar.selectedModel.name || toolbar.selectedModel.id}`
      : toolbar.modelLabel || modelLabel || t('composer.modelPlaceholder'),
  );
  const effortLabel = $derived(
    supportedThinkingLevels(toolbar.selectedModel).includes(toolbar.thinkingLevel)
      ? t('thinking.' + toolbar.thinkingLevel)
      : '',
  );
  const effortTitle = $derived(
    effortLabel ? `${t('composer.switchEffort')} · ${effortLabel}` : t('composer.switchEffort'),
  );
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#snippet toolbarContent(permissionControl)}
  <div class="pi-chat-toolbar">
    <div class="pi-chat-toolbar-left">
      {#if chatAvailable}
        <details class="composer-add" bind:this={attachMenu}>
          <summary class="pi-chat-icon-button" aria-label={t('composer.addAttachment')}
            >{@html icon(Plus, { size: 19 })}</summary
          >
          <div class="composer-add-menu">
            <button type="button" onclick={() => chooseAttachment('pi-chat-files')}
              >{@html icon(Paperclip, { size: 16 })}{t('composer.uploadFiles')}</button
            >
            <button type="button" onclick={() => chooseAttachment('pi-chat-images')}
              >{@html icon(Paperclip, { size: 16 })}{t('composer.attachPhotos')}</button
            >
            <button type="button" onclick={() => chooseAttachment('pi-chat-camera')}
              >{@html icon(Camera, { size: 16 })}{t('composer.takePhoto')}</button
            >
            <button
              type="button"
              id="pi-chat-commands-btn"
              aria-controls="pi-chat-slash-popup"
              onclick={() => (attachMenu.open = false)}
              >{@html icon(Terminal, { size: 16 })}{t('plugins.skills')}</button
            >
          </div>
        </details>
      {/if}
      <span id="pi-chat-status" class="pi-chat-status {toolbar.statusClass}">{statusText}</span>
      <button
        type="button"
        id="pi-chat-model-label"
        class="pi-chat-model-label"
        title={modelTitle}
        style:display={chatAvailable ? '' : 'none'}
        disabled={!chatAvailable}>{modelTitle}</button
      >
      <ContextUsage />
    </div>
    <div class="actions" class:running={toolbar.isRunning}>
      {@render permissionControl?.()}
      <div class="thinking-control" hidden={!chatAvailable || !toolbar.canAdjustThinking}>
        <button
          type="button"
          id="pi-chat-thinking-label"
          class="pi-chat-thinking-label"
          title={effortTitle}
          aria-label={effortTitle}
          aria-controls="pi-chat-thinking-popup"
          aria-expanded="false"
          disabled={!chatAvailable}
          >{@html icon(Gauge, { size: 20, strokeWidth: 2.4 })}
          <span>{effortLabel || t('composer.switchEffort')}</span>
          {@html icon(ChevronDown, { size: 13 })}</button
        >
        <div id="pi-chat-thinking-popup" class="pi-chat-thinking-popup" style="display: none" inert>
          <div
            id="pi-chat-thinking-list"
            class="pi-chat-thinking-list"
            role="group"
            aria-label={t('composer.switchEffort')}
          ></div>
        </div>
      </div>
      <button
        type="button"
        id="pi-chat-cancel"
        class="pi-chat-cancel"
        style:display={toolbar.isRunning ? '' : 'none'}
        title={t('composer.stopHint')}
        aria-label={t('composer.cancelRunning')}
        disabled={toolbar.statusText === 'cancelling' || toolbar.compacting || !chatAvailable}
        >{@html icon(Square, { size: 13, class: 'pi-chat-stop-glyph' })}<span
          >{t('composer.stop')}</span
        ></button
      >
      <button
        type="button"
        id="pi-chat-queue"
        class="pi-chat-queue"
        style:display={toolbar.isRunning ? '' : 'none'}
        title={t('composer.queueHint')}
        disabled>{t('composer.queue')}</button
      >
      <button type="submit" id="pi-chat-send" class="pi-chat-send" disabled
        >{toolbar.isRunning ? t('composer.steer') : t('composer.send')}</button
      >
    </div>
  </div>
{/snippet}

{#if chatAvailable && sessionId}
  <ComputerPermission {sessionId} model={toolbar.selectedModel} running={toolbar.isRunning}>
    {#snippet children(permissionControl)}
      {@render toolbarContent(permissionControl)}
    {/snippet}
  </ComputerPermission>
{:else}
  {@render toolbarContent(null)}
{/if}

<svelte:window
  onclick={(event) => {
    if (attachMenu?.open && !attachMenu.contains(event.target)) attachMenu.open = false;
  }}
  onkeydown={(event) => {
    if (attachMenu?.open && event.key === 'Escape') attachMenu.open = false;
  }}
/>

<style>
  :global(#spa-root) .pi-chat-thinking-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 40px;
    padding: 5px 9px;
    border: 1px solid color-mix(in srgb, var(--text) 45%, var(--input-bg));
    border-radius: 10px;
    color: var(--text);
    background: color-mix(in srgb, var(--text) 14%, var(--input-bg));
    font-size: 13px;
    font-weight: 650;
  }
  .pi-chat-thinking-label:is(:hover, :focus-visible) {
    background: color-mix(in srgb, var(--text) 22%, var(--input-bg));
  }
  .thinking-control {
    position: relative;
  }
  .thinking-control[hidden] {
    display: none;
  }
  .thinking-control .pi-chat-thinking-popup {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    max-height: min(320px, max(84px, calc(var(--pi-visual-height, 100dvh) - 150px)));
    overscroll-behavior: contain;
  }
  .pi-chat-thinking-label :global(svg:last-child) {
    transition: rotate var(--motion-control, 140ms) ease;
  }
  .pi-chat-thinking-label:global([aria-expanded='true']) :global(svg:last-child) {
    rotate: 180deg;
  }
  .pi-chat-toolbar {
    overflow: visible;
  }
  .pi-chat-toolbar-left:has(.composer-add[open]) {
    overflow: visible !important;
  }
  .composer-add {
    position: relative;
    flex: none;
  }
  .composer-add summary {
    display: grid;
    place-items: center;
    min-width: 36px;
    min-height: 36px;
    list-style: none;
    cursor: pointer;
  }
  .composer-add summary::-webkit-details-marker {
    display: none;
  }
  .composer-add-menu {
    position: absolute;
    z-index: 15;
    left: 0;
    bottom: calc(100% + 6px);
    background: var(--surface);
    border: 1px solid var(--dim);
    padding: 4px;
    border-radius: 12px;
    box-shadow: 0 8px 30px #0004;
    white-space: nowrap;
  }
  .composer-add-menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 42px;
    width: 100%;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 8px;
    padding: 6px 10px;
    text-align: left;
    cursor: pointer;
  }
  .composer-add-menu button:is(:hover, :focus-visible) {
    background: var(--hover);
  }
</style>

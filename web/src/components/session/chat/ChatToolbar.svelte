<script>
  import { icon, Camera, Paperclip, Plus } from '../../../shared/icons.js';
  import { t } from '../../../shared/i18n.js';
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
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

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
        </div>
      </details>
    {/if}
    <span id="pi-chat-status" class="pi-chat-status {toolbar.statusClass}">{statusText}</span>
    <button
      type="button"
      id="pi-chat-model-label"
      class="pi-chat-model-label"
      title={t('composer.switchModel')}
      style:display={chatAvailable ? '' : 'none'}
      disabled={!chatAvailable}
      >{toolbar.modelLabel || modelLabel || t('composer.modelPlaceholder')}</button
    >
    <ContextUsage />
  </div>
  <div class="actions">
    {#if chatAvailable && sessionId}
      <ComputerPermission {sessionId} model={toolbar.selectedModel} running={toolbar.isRunning} />
    {/if}
    <button
      type="button"
      id="pi-chat-thinking-label"
      class="pi-chat-thinking-label {toolbar.thinkingLevel
        ? 'thinking-' + toolbar.thinkingLevel
        : ''}"
      style:display={chatAvailable && toolbar.canAdjustThinking ? '' : 'none'}
      title={t('composer.switchEffort')}
      aria-label={t('composer.switchEffort')}
      disabled={!chatAvailable}
      >{t(
        toolbar.thinkingLevel ? 'thinking.' + toolbar.thinkingLevel : 'composer.switchEffort',
      )}</button
    >
    <button
      type="button"
      id="pi-chat-cancel"
      class="pi-chat-cancel"
      style:display={toolbar.isRunning ? '' : 'none'}
      title={t('composer.cancelRunning')}
      aria-label={t('composer.cancelRunning')}
      disabled={toolbar.statusText === 'cancelling' || !chatAvailable}
      >{t('composer.cancel')}</button
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

<svelte:window
  onclick={(event) => {
    if (attachMenu?.open && !attachMenu.contains(event.target)) attachMenu.open = false;
  }}
  onkeydown={(event) => {
    if (attachMenu?.open && event.key === 'Escape') attachMenu.open = false;
  }}
/>

<style>
  .pi-chat-toolbar:has(:global(details[open])) {
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

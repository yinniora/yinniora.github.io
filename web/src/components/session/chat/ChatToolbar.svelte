<script>
  import {
    icon,
    ArrowUp,
    Camera,
    ListPlus,
    CornerDownRight,
    Image,
    Gauge,
    Layers,
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
  const modelControlLabel = $derived(
    toolbar.canAdjustThinking && effortLabel ? `${modelTitle} · ${effortLabel}` : modelTitle,
  );
  const sendLabel = $derived(t('composer.' + toolbar.sendAction));
  const sendIcon = $derived(
    toolbar.sendAction === 'queue'
      ? ListPlus
      : toolbar.sendAction === 'steer'
        ? CornerDownRight
        : ArrowUp,
  );
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#snippet toolbarContent(permissionControl)}
  <div class="pi-chat-toolbar">
    <div class="pi-chat-toolbar-left">
      {#if chatAvailable}
        <details class="composer-add" bind:this={attachMenu}>
          <summary class="pi-chat-icon-button" aria-label={t('composer.addAttachment')}
            >{@html icon(Plus, { size: 18 })}</summary
          >
          <div class="composer-add-menu">
            <button type="button" onclick={() => chooseAttachment('pi-chat-files')}
              >{@html icon(Paperclip, { size: 19 })}{t('composer.uploadFiles')}</button
            >
            <button type="button" onclick={() => chooseAttachment('pi-chat-images')}
              >{@html icon(Image, { size: 19 })}{t('composer.attachPhotos')}</button
            >
            <button type="button" onclick={() => chooseAttachment('pi-chat-camera')}
              >{@html icon(Camera, { size: 19 })}{t('composer.takePhoto')}</button
            >
            <button
              type="button"
              id="pi-chat-commands-btn"
              aria-controls="pi-chat-slash-popup"
              onclick={() => (attachMenu.open = false)}
              >{@html icon(Terminal, { size: 19 })}{t('plugins.skills')}</button
            >
          </div>
        </details>
      {/if}
      <span id="pi-chat-status" class="pi-chat-status {toolbar.statusClass}">{statusText}</span>
      {@render permissionControl?.()}
    </div>
    <div class="composer-model-controls">
      <ContextUsage />
      <button
        type="button"
        id="pi-chat-model-label"
        class="pi-chat-model-label"
        title={modelControlLabel}
        aria-label={modelControlLabel}
        aria-controls="pi-chat-model-popup"
        aria-expanded="false"
        aria-haspopup="dialog"
        style:display={chatAvailable ? '' : 'none'}
        disabled={!chatAvailable}
      >
        {@html icon(toolbar.canAdjustThinking ? Gauge : Layers, { size: 18 })}
      </button>
    </div>
    <div class="actions" class:running={toolbar.isRunning}>
      <button
        type="button"
        id="pi-chat-cancel"
        class="pi-chat-cancel"
        style:display={toolbar.isRunning ? '' : 'none'}
        title={t('composer.stopHint')}
        aria-label={t('composer.cancelRunning')}
        disabled={toolbar.statusText === 'cancelling' || toolbar.compacting || !chatAvailable}
        >{@html icon(Square, { size: 18, class: 'pi-chat-stop-glyph' })}<span
          >{t('composer.stop')}</span
        ></button
      >
      <button
        type="submit"
        id="pi-chat-send"
        class="pi-chat-send"
        title={toolbar.sendAction === 'queue' ? t('composer.queueHint') : sendLabel}
        aria-label={sendLabel}
        disabled
      >
        {@html icon(sendIcon, { size: 18 })}<span>{sendLabel}</span>
      </button>
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
  .composer-add {
    position: relative;
    flex: none;
  }
  .composer-add summary {
    list-style: none;
  }
  .composer-add summary::-webkit-details-marker {
    display: none;
  }
  .composer-add-menu {
    position: absolute;
    z-index: 15;
    left: 0;
    bottom: calc(100% + 8px);
    display: grid;
    gap: 4px;
    width: min(222px, calc(100vw - 42px));
    max-height: max(100px, calc(var(--pi-visual-height, 100dvh) - 125px));
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--surface);
    border: 1px solid var(--dim);
    padding: 8px;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
    font-family: var(--font-sans);
    font-size: 16px;
    font-weight: 550;
  }
  .composer-add-menu button {
    display: flex;
    align-items: center;
    gap: 13px;
    min-height: 52px;
    width: 100%;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 10px;
    padding: 9px 12px;
    text-align: left;
    cursor: pointer;
  }
  .composer-add-menu button :global(svg) {
    flex: none;
    opacity: 0.75;
  }
  .composer-add-menu button:is(:hover, :focus-visible, :active) {
    background: var(--hover);
  }
</style>

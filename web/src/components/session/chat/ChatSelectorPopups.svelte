<script>
  import { t } from '../../../shared/i18n.js';
  import { icon, Gauge, Search, X } from '../../../shared/icons.js';
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<div id="pi-chat-model-backdrop" class="picker-backdrop" aria-hidden="true" hidden></div>
<div
  id="pi-chat-model-popup"
  class="pi-chat-model-popup"
  role="dialog"
  aria-labelledby="pi-chat-model-title"
  tabindex="-1"
  style="display: none"
  inert
>
  <header class="picker-heading">
    <h2 id="pi-chat-model-title">{t('composer.switchModel')}</h2>
    <button id="pi-chat-model-close" type="button" aria-label={t('common.close')}>
      {@html icon(X, { size: 18 })}
    </button>
  </header>
  <label class="picker-search">
    {@html icon(Search, { size: 17 })}
    <input
      type="search"
      id="pi-chat-model-search"
      class="pi-chat-model-search"
      aria-label={t('composer.searchModels')}
      placeholder={t('composer.searchModels')}
      autocomplete="off"
    />
  </label>
  <div id="pi-chat-effort-controls" class="picker-effort" hidden>
    <span id="pi-chat-effort-label"
      >{@html icon(Gauge, { size: 16 })}{t('composer.switchEffort')}</span
    >
    <div id="pi-chat-thinking-list" role="group" aria-labelledby="pi-chat-effort-label"></div>
  </div>
  <div id="pi-chat-model-note" class="picker-note" role="status" hidden></div>
  <div id="pi-chat-model-list" class="pi-chat-model-list"></div>
</div>
<div id="pi-chat-slash-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-slash-list" class="pi-chat-slash-list"></div>
</div>
<div id="pi-chat-mention-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-mention-list" class="pi-chat-slash-list"></div>
</div>

<style>
  .picker-backdrop {
    display: none;
  }
  .pi-chat-model-popup {
    box-sizing: border-box;
    inset: auto 0 calc(100% + 8px) auto;
    width: min(410px, 100%);
    max-height: min(
      540px,
      calc(var(--pi-visual-height, 100dvh) - var(--pi-chat-composer-height, 136px) - 64px)
    );
    padding: 9px 10px 10px;
    overflow: auto;
    overscroll-behavior: contain;
    border-radius: 18px;
    background: var(--surface, var(--container-bg));
    box-shadow: 0 12px 36px rgb(0 0 0 / 20%);
    color: var(--text);
    font-family: system-ui, sans-serif;
    --picker-accent: var(--workspace-brand, var(--accent));
  }
  .pi-chat-model-popup:focus {
    outline: none;
  }
  .picker-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: none;
    padding-inline-start: 7px;
  }
  .picker-heading h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 680;
  }
  .picker-heading button {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 11px;
    background: transparent;
    color: var(--text-soft);
    cursor: pointer;
  }
  .picker-heading button:hover {
    background: var(--hover);
    color: var(--text);
  }
  .picker-search {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 0 11px;
    background: var(--input-bg);
    border: 1px solid var(--dim);
    border-radius: 11px;
    color: var(--text-soft);
  }
  .picker-search:focus-within {
    border-color: var(--picker-accent);
  }
  .picker-search .pi-chat-model-search {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0;
    border: none;
    font-size: 16px;
    outline: none;
  }
  :global(#spa-root) .picker-search .pi-chat-model-search:focus-visible {
    outline: none;
  }
  .picker-effort {
    padding: 10px 5px 9px;
    border-bottom: 1px solid var(--dim);
  }
  #pi-chat-effort-label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-soft);
    font-size: 13px;
    font-weight: 650;
  }
  #pi-chat-thinking-list {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  #pi-chat-thinking-list :global(.thinking-level-item) {
    flex: 0 0 auto;
    justify-content: center;
    gap: 5px;
    min-width: 44px;
    min-height: 44px;
    width: auto;
    padding: 5px 10px;
    border: 1px solid var(--dim);
    border-radius: 10px;
    color: var(--text-soft);
    font: inherit;
    font-size: 14px;
    white-space: nowrap;
  }
  #pi-chat-thinking-list :global(.thinking-level-item.selected) {
    color: var(--text);
    background: color-mix(in srgb, var(--picker-accent) 14%, var(--surface));
    border-color: color-mix(in srgb, var(--picker-accent) 70%, var(--dim));
  }
  #pi-chat-thinking-list :global(.thinking-level-item:not(.selected) .thinking-choice-mark) {
    display: none;
  }
  #pi-chat-thinking-list :global(.thinking-level-item:disabled) {
    opacity: 0.45;
    cursor: wait;
  }
  .picker-note {
    margin: 7px 4px 0;
    color: var(--danger-fg, var(--error));
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .pi-chat-model-list {
    min-height: min(74px, 22dvh);
    margin-top: 6px;
    padding: 0 3px;
    overscroll-behavior: contain;
  }
  .pi-chat-model-list :global(.model-provider) {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 7px 0 2px;
    padding: 3px 9px;
    border: 0;
    color: var(--text-soft);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: normal;
    text-transform: none;
    overflow-wrap: anywhere;
  }
  .pi-chat-model-list :global(.model-item) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 48px;
    margin-bottom: 2px;
    padding: 7px 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    text-align: start;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .pi-chat-model-list :global(.model-item .model-choice-mark) {
    flex: none;
    color: var(--picker-accent);
  }
  .pi-chat-model-list :global(.model-item.selected) {
    background: color-mix(in srgb, var(--picker-accent) 11%, var(--surface));
    border-color: color-mix(in srgb, var(--picker-accent) 20%, var(--dim));
  }
  .pi-chat-model-list :global(.model-item.active) {
    outline: 1px solid var(--picker-accent);
    outline-offset: -2px;
  }
  .pi-chat-model-list :global(.model-empty) {
    padding: 12px 10px;
    color: var(--text-soft);
    font-size: 14px;
  }
  @media (min-width: 901px) {
    :global(.pi-chat-shell.expanded) .pi-chat-model-popup {
      inset-block: 8px auto;
      max-height: min(490px, 65dvh);
    }
  }
  @media (max-width: 900px) {
    .picker-backdrop:not([hidden]) {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 1099;
      height: var(--pi-visual-height, 100dvh);
      background: rgb(0 0 0 / 24%);
    }
    .pi-chat-model-popup {
      --picker-top: max(8px, env(safe-area-inset-top, 0px));
      --picker-bottom: max(8px, env(safe-area-inset-bottom, 0px));
      --picker-room: calc(
        var(--pi-visual-height, 100dvh) - var(--picker-top) - var(--picker-bottom)
      );
      position: fixed;
      inset: auto 12px calc(100% - var(--pi-visual-height, 100dvh) + var(--picker-bottom));
      width: min(460px, calc(100% - 24px));
      height: min(490px, var(--picker-room));
      max-height: var(--picker-room);
      margin-inline: auto;
      z-index: 1100;
    }
    :global(.pi-keyboard-open) .pi-chat-model-popup {
      --picker-bottom: 8px;
    }
    :global(.pi-keyboard-open) #pi-chat-thinking-list {
      overflow-x: auto;
      flex-wrap: nowrap;
      padding-bottom: 3px;
      overscroll-behavior-inline: contain;
    }
  }
</style>

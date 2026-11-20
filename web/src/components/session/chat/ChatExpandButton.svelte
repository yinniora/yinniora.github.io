<script>
  import { icon, KeyboardOff, Maximize2 } from '../../../shared/icons.js';
  import { t } from '../../../shared/i18n.js';

  let { chatAvailable = true } = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<button
  type="button"
  id="pi-chat-expand"
  class="pi-chat-expand-button"
  title={t('composer.expand')}
  aria-label={t('composer.expand')}
  aria-pressed="false"
  disabled={!chatAvailable}>{@html icon(Maximize2, { size: 14 })}</button
>

<button
  type="button"
  class="pi-chat-expand-button dismiss-keyboard"
  aria-label={t('composer.dismissKeyboard')}
  title={t('composer.dismissKeyboard')}
  onpointerdown={(event) => event.preventDefault()}
  onclick={() => document.getElementById('pi-chat-message')?.blur()}
  disabled={!chatAvailable}>{@html icon(KeyboardOff, { size: 17 })}</button
>

<style>
  .dismiss-keyboard {
    display: none;
  }
  @media (max-width: 760px) {
    #pi-chat-expand {
      display: none;
    }
    :global(.pi-keyboard-open) .dismiss-keyboard {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
      opacity: 1;
    }
  }
</style>

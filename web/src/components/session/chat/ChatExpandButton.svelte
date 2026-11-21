<script>
  import { icon, Maximize, Minimize } from '../../../shared/icons.js';
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
  aria-controls="pi-chat-message"
  onmousedown={(event) => {
    if (document.activeElement?.id === 'pi-chat-message') event.preventDefault();
  }}
  disabled={!chatAvailable}
>
  <span class="expand-glyph">{@html icon(Maximize, { size: 18 })}</span>
  <span class="collapse-glyph">{@html icon(Minimize, { size: 18 })}</span>
</button>

<style>
  .collapse-glyph,
  button:global([aria-pressed='true']) .expand-glyph {
    display: none;
  }
  .expand-glyph,
  button:global([aria-pressed='true']) .collapse-glyph {
    display: grid;
  }
</style>

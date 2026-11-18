<script>
  import { icon, Copy } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { showToast } from '../../shared/toast.js';

  let { text, iconOnly = false } = $props();
  const label = $derived(t('artifact.copy'));

  async function copy() {
    const copied = await copyToClipboard(text);
    showToast(t(copied ? 'common.copied' : 'common.copyFailed'));
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icon -->
<button
  type="button"
  class="reply-copy"
  aria-label={label}
  title={iconOnly ? label : undefined}
  onclick={copy}
>
  {@html icon(Copy, { size: 14 })}
  {#if !iconOnly}{label}{/if}
</button>

<style>
  .reply-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 32px;
    min-height: 32px;
    padding: 4px 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: inherit;
  }
  .reply-copy:hover,
  .reply-copy:focus-visible {
    background: var(--hover);
  }
  @media (pointer: coarse) {
    .reply-copy {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>

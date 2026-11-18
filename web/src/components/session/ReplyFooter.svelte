<script>
  import { icon, Copy } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { showToast } from '../../shared/toast.js';
  import { formatTimestamp } from '../../session/render/entry-format.js';

  let { text, model, timestamp } = $props();
  const date = $derived(timestamp ? new Date(timestamp) : null);
  const time = $derived(date && Number.isFinite(date.getTime()) ? formatTimestamp(date) : '');

  async function copyReply() {
    const copied = await copyToClipboard(text);
    showToast(t(copied ? 'common.copied' : 'common.copyFailed'));
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icon -->

<div class="reply-footer">
  <button type="button" class="reply-copy" onclick={copyReply}
    >{@html icon(Copy, { size: 14 })}{t('artifact.copy')}</button
  >
  {#if model}<span class="reply-model" title={model}>{model}</span>{/if}
  {#if time}<time datetime={date.toISOString()} title={date.toLocaleString()}>{time}</time>{/if}
</div>

<style>
  .reply-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 8px;
    color: var(--text-soft);
    font-size: 11px;
    line-height: 1.4;
  }

  .reply-copy {
    display: inline-flex;
    align-items: center;
    gap: 5px;
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

  .reply-model {
    overflow-wrap: anywhere;
  }

  time {
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    .reply-copy {
      min-height: 44px;
    }
  }
</style>

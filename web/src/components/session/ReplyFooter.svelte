<script>
  import CopyMessageButton from './CopyMessageButton.svelte';
  import { formatTimestamp } from '../../session/render/entry-format.js';

  let { text, model, timestamp } = $props();
  const date = $derived(timestamp ? new Date(timestamp) : null);
  const time = $derived(date && Number.isFinite(date.getTime()) ? formatTimestamp(date) : '');
</script>

<div class="reply-footer">
  <div class="reply-actions">
    <CopyMessageButton {text} />
    {#if time}<time datetime={date.toISOString()} title={date.toLocaleString()}>{time}</time>{/if}
  </div>
  {#if model}<span class="reply-model" title={model}>{model}</span>{/if}
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

  .reply-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }

  .reply-model {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
</style>

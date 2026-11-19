<script>
  import CopyMessageButton from './CopyMessageButton.svelte';

  // The reply time lives beside the prompt (when it was asked); the turn's
  // duration is on the activity summary. The footer keeps copy, model and menu.
  let { text, model, timestamp, menu } = $props();
  // Provider ids can be long opaque hashes; the model name is what people read.
  const modelName = $derived(model ? model.split('/').filter(Boolean).pop() : '');
  const date = $derived(timestamp ? new Date(timestamp) : null);
  const title = $derived(
    [model, date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '']
      .filter(Boolean)
      .join('\n'),
  );
</script>

<div class="reply-footer">
  {#if text?.trim()}<CopyMessageButton {text} />{/if}
  {#if modelName}<span class="reply-model" {title}>{modelName}</span>{/if}
  {@render menu?.()}
</div>

<style>
  .reply-footer {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 6px;
    color: var(--text-soft);
    font-size: 11px;
    line-height: 1.4;
  }

  .reply-model {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
</style>

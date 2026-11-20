<script>
  import { t } from '../../shared/i18n.js';
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  import { Brain } from '../../shared/icons.js';
  let { id, text, live } = $props();
  // Reasoning summaries open with a title line (**Title** or # Title). Show it
  // on the folded row, as Codex does; plain thoughts keep the generic label.
  const preview = $derived.by(() => {
    const first =
      String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
    const title = /^(?:\*\*(.+?)\*\*|#{1,6}\s+(.+))$/.exec(first);
    return title ? (title[1] || title[2]).trim() : '';
  });
</script>

{#if live}
  <ActivityDisclosure
    kind="thinking"
    {id}
    label={t('activity.thinking')}
    summary={preview}
    glyph={Brain}
  >
    <div class="activity-thinking-text">{text}</div>
  </ActivityDisclosure>
{:else}
  <div class="thinking-block">
    <div class="thinking-text">{text}</div>
    <div class="thinking-collapsed">Thinking ...</div>
  </div>
{/if}

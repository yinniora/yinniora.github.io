<script>
  import { t } from '../../shared/i18n.js';
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  import { Brain } from '../../shared/icons.js';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  let { id, text, live, running = false } = $props();
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

<!-- eslint-disable svelte/no-at-html-tags -- sanitized Markdown -->
{#if live}
  <ActivityDisclosure
    kind="thinking"
    {id}
    label={t('activity.thinking')}
    summary={preview}
    glyph={Brain}
    {running}
  >
    <div class="activity-thinking-text markdown-content">
      {@html safeMarkedParse(text, { marked })}
    </div>
  </ActivityDisclosure>
{:else}
  <div class="thinking-block">
    <div class="thinking-text">{text}</div>
    <div class="thinking-collapsed">Thinking ...</div>
  </div>
{/if}

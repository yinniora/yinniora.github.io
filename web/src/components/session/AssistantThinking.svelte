<script>
  import { t } from '../../shared/i18n.js';
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  let { id, text, live } = $props();
</script>

{#if live}
  <ActivityDisclosure kind="thinking" {id} label={t('activity.thinking')}>
    <div class="activity-thinking-text">{text}</div>
  </ActivityDisclosure>
{:else}
  <div class="thinking-block">
    <div class="thinking-text">{text}</div>
    <div class="thinking-collapsed">Thinking ...</div>
  </div>
{/if}

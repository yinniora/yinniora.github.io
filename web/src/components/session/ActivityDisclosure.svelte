<script>
  import { icon, ChevronRight, Clock, Loader, Check, X } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { sessionRuntime } from '../../session/session-runtime.js';
  let { kind, id, label, summary = '', status = '', required = false, children } = $props();
  const indicators = {
    pending: { glyph: Loader, label: 'activity.running' },
    success: { glyph: Check, label: 'activity.done' },
    error: { glyph: X, label: 'activity.failed' },
    timeout: { glyph: Clock, label: 'activity.timedOut' },
  };
  const indicator = $derived(indicators[status]);
  let element;
  function toggle(event) {
    event.preventDefault();
    const open = !element.open;
    element.open = open;
    sessionRuntime.toggleState?.setDisclosure?.(id, open);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<details
  bind:this={element}
  class="activity-disclosure"
  class:activity-thinking={kind === 'thinking'}
  data-display-kind={kind}
  data-collapse-key={id}
  data-requires-response={required ? 'true' : undefined}
  open={required}
>
  <summary onclick={toggle}>
    <span class="activity-chevron" aria-hidden="true">{@html icon(ChevronRight, { size: 15 })}</span
    >
    <span class="activity-label">{label}</span>
    {#if summary}<span class="activity-summary" title={summary}>{summary}</span>{/if}
    {#if indicator}<span
        class="activity-status"
        class:pending={status === 'pending'}
        class:failed={status === 'error'}
        class:timed-out={status === 'timeout'}
        title={t(indicator.label)}
      >
        {@html icon(indicator.glyph, { size: 14 })}
        {t(indicator.label)}
      </span>{/if}
  </summary>
  <div class="activity-body">{@render children()}</div>
</details>

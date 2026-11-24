<script>
  import {
    icon,
    ChevronRight,
    ChevronUp,
    CircleAlert,
    Clock,
    Loader,
    Check,
    X,
  } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { sessionRuntime } from '../../session/session-runtime.js';
  let {
    kind,
    id,
    entryId,
    label,
    summary = '',
    status = '',
    required = false,
    running = false,
    unfinished = false,
    glyph = null,
    deferBody = false,
    children,
  } = $props();
  const indicators = {
    pending: { glyph: Loader, label: 'activity.running' },
    success: { glyph: Check, label: 'activity.done' },
    error: { glyph: X, label: 'activity.failed' },
    timeout: { glyph: Clock, label: 'activity.timedOut' },
    stopped: { glyph: CircleAlert, label: 'activity.stopped' },
  };
  const indicator = $derived(indicators[status]);
  let element;
  let expanded = $state(false);
  function setOpen(open) {
    element.open = open;
    sessionRuntime.toggleState?.setDisclosure?.(id, open, { transient: running });
  }
  function toggle(event) {
    event.preventDefault();
    setOpen(!element.open);
  }
  // Long thinking and tool runs push the summary off screen; fold from the end
  // and bring the summary back into view.
  function collapseFromEnd() {
    setOpen(false);
    const summary = element.querySelector(':scope > summary');
    if (summary && summary.getBoundingClientRect().top < 0) {
      summary.scrollIntoView({ block: 'start' });
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<details
  bind:this={element}
  class="activity-disclosure"
  class:activity-thinking={kind === 'thinking'}
  class:activity-group={kind === 'group'}
  data-display-kind={kind}
  data-glyph={glyph ? 'true' : undefined}
  data-collapse-key={id}
  data-requires-response={required ? 'true' : undefined}
  data-running={running ? 'true' : undefined}
  data-unfinished={unfinished ? 'true' : undefined}
  open={required || running}
  ontoggle={(event) => {
    if (deferBody) expanded = event.currentTarget.open;
  }}
>
  <summary id={entryId ? `entry-${entryId}` : undefined} onclick={toggle}>
    {#if glyph}<span class="activity-glyph" aria-hidden="true"
        >{@html icon(glyph, { size: 14 })}</span
      >{/if}
    <span class="activity-chevron" aria-hidden="true">{@html icon(ChevronRight, { size: 15 })}</span
    >
    <span class="activity-label">{label}</span>
    {#if summary}<span class="activity-summary" title={summary}>{summary}</span>{/if}
    {#if indicator}<span
        class="activity-status"
        class:pending={status === 'pending'}
        class:failed={status === 'error'}
        class:timed-out={status === 'timeout'}
        class:stopped={status === 'stopped'}
        title={t(indicator.label)}
      >
        {@html icon(indicator.glyph, { size: 14 })}
        {t(indicator.label)}
      </span>{/if}
  </summary>
  {#if !deferBody || expanded}
    <div class="activity-body">
      {@render children()}
      {#if kind === 'group'}
        <button
          type="button"
          class="activity-collapse-end"
          aria-label={t('activity.collapse', { name: label })}
          onclick={collapseFromEnd}
          >{@html icon(ChevronUp, { size: 15 })}<span>{t('activity.collapseShort')}</span></button
        >
      {/if}
    </div>
  {/if}
</details>

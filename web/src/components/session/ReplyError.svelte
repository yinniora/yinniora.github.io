<script>
  import {
    icon,
    CircleAlert,
    ChevronRight,
    Layers,
    Play,
    RotateCcw,
    Square,
  } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let {
    error = '',
    model = '',
    interrupted = false,
    labelKey = '',
    onChooseModel = null,
    onRetry = null,
    onCompact = null,
    onContinue = null,
    actionsOnly = false,
  } = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
{#snippet label()}
  {@html icon(interrupted ? Square : CircleAlert, { size: 14 })}
  <span>{t(labelKey || (interrupted ? 'activity.interrupted' : 'activity.failed'))}</span>
  {#if model}<small>{model}</small>{/if}
{/snippet}

{#if actionsOnly}
  <!-- The surrounding block already names the state. -->
{:else if error}
  <details class="reply-error" class:reply-interrupted={interrupted}>
    <summary>
      {@render label()}
      <span class="reply-error-chevron" aria-hidden="true"
        >{@html icon(ChevronRight, { size: 14 })}</span
      >
    </summary>
    <div class="reply-error-detail">{error}</div>
  </details>
{:else}
  <div class="reply-error" class:reply-interrupted={interrupted}>
    <div class="reply-error-label">{@render label()}</div>
  </div>
{/if}
{#if onChooseModel || onRetry || onCompact || onContinue}
  <div class="reply-error-actions">
    {#if onContinue}<button class="reply-action-primary" type="button" onclick={onContinue}
        >{@html icon(Play, { size: 14 })}<span>{t('activity.continue')}</span></button
      >{/if}
    {#if onCompact}<button class="compact-action" type="button" onclick={onCompact}
        >{t('piSession.compact')}</button
      >{/if}
    {#if onChooseModel}<button
        type="button"
        class:reply-action-labeled={onContinue}
        aria-label={t('models.title')}
        title={t('models.title')}
        onclick={onChooseModel}
      >
        {@html icon(Layers, { size: 15 })}{#if onContinue}<span>{t('activity.switchModel')}</span
          >{/if}
      </button>{/if}
    {#if onRetry}<button
        type="button"
        aria-label={t('common.retry')}
        title={t('common.retry')}
        onclick={onRetry}
      >
        {@html icon(RotateCcw, { size: 15 })}
      </button>{/if}
  </div>
{/if}

<style>
  .reply-error {
    max-width: 100%;
    width: fit-content;
    border: 1px solid var(--dim);
    background: var(--surface);
    border-radius: 9px;
    font-size: 12px;
    margin: 8px 0;
  }
  summary,
  .reply-error-label {
    display: flex;
    align-items: center;
    gap: 7px;
    list-style: none;
    padding: 9px 10px;
    min-height: 38px;
    color: var(--error);
  }
  summary {
    cursor: pointer;
  }
  .reply-interrupted :is(summary, .reply-error-label) {
    color: var(--warning);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  :is(summary, .reply-error-label) > span:first-of-type {
    flex: none;
    overflow-wrap: anywhere;
  }
  small {
    color: var(--text-soft);
    overflow-wrap: anywhere;
  }
  .reply-error-chevron {
    margin-left: auto;
  }
  details[open] .reply-error-chevron {
    transform: rotate(90deg);
  }
  .reply-error-detail {
    border-top: 1px solid var(--dim);
    padding: 9px 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 240px;
    overflow-y: auto;
    color: var(--text-soft);
  }
  .reply-error-actions {
    display: flex;
    gap: 4px;
    color: var(--text-soft);
  }
  .reply-error-actions button {
    display: grid;
    place-items: center;
    width: 34px;
    min-height: 34px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .reply-error-actions {
    flex-wrap: wrap;
    align-items: center;
  }
  .reply-error-actions :is(.reply-action-primary, .reply-action-labeled) {
    display: inline-flex;
    gap: 6px;
    width: auto;
    padding: 0 12px;
    border: 1px solid var(--dim);
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
  }
  .reply-error-actions .reply-action-primary {
    border-color: var(--text);
    background: var(--text);
    color: var(--body-bg, var(--bg));
  }
  .reply-error-actions .reply-action-primary:is(:hover, :focus-visible) {
    background: color-mix(in srgb, var(--text) 82%, var(--bg));
  }
  .reply-error-actions button:hover,
  .reply-error-actions button:focus-visible {
    background: var(--hover);
  }
  @media (pointer: coarse) {
    .reply-error-actions button {
      width: 44px;
      min-height: 44px;
    }
  }
  .reply-error-actions .compact-action {
    width: auto;
    padding-inline: 8px;
    font-size: 12px;
  }
</style>

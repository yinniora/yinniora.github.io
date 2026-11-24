<script>
  import {
    icon,
    CircleAlert,
    ChevronRight,
    Layers,
    Minimize,
    Play,
    RotateCcw,
    Square,
  } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import {
    providerFailureLabelKey,
    providerModelUnavailable,
    providerNetworkFailure,
  } from '../../session/render/reply-details.js';

  let {
    error = '',
    model = '',
    interrupted = false,
    labelKey = '',
    onChooseModel = null,
    onRetry = null,
    retryLabelKey = 'common.retry',
    onCompact = null,
    onContinue = null,
    actionsOnly = false,
  } = $props();
  const modelUnavailable = $derived(providerModelUnavailable(error));
  const errorLabelKey = $derived(
    labelKey ||
      (interrupted
        ? 'activity.interrupted'
        : modelUnavailable
          ? 'activity.modelUnavailable'
          : providerFailureLabelKey(providerNetworkFailure(error)) || 'activity.failed'),
  );
  const hasActions = $derived(onChooseModel || onRetry || onCompact || onContinue);
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
{#snippet heading()}
  <span class="reply-error-mark"
    >{@html icon(interrupted ? Square : CircleAlert, { size: 15 })}</span
  >
  <span class="reply-error-heading">
    <span class="reply-error-title">{t(errorLabelKey)}</span>
    {#if model}<small>{model}</small>{/if}
  </span>
{/snippet}

{#snippet chooseModel(primary = false)}
  <button
    type="button"
    class:reply-action-primary={primary}
    title={t('activity.switchModel')}
    onclick={onChooseModel}
    >{@html icon(Layers, { size: 15 })}<span
      >{t(primary ? 'activity.switchModel' : 'models.title')}</span
    ></button
  >
{/snippet}

{#snippet actions(standalone = false)}
  <div class="reply-error-actions" class:reply-error-actions-standalone={standalone}>
    {#if onContinue}<button class="reply-action-primary" type="button" onclick={onContinue}
        >{@html icon(Play, { size: 15 })}<span>{t('activity.continue')}</span></button
      >{/if}
    {#if modelUnavailable && onChooseModel}{@render chooseModel(true)}{/if}
    {#if onRetry}<button
        class:reply-action-primary={!onContinue && !(modelUnavailable && onChooseModel)}
        type="button"
        onclick={onRetry}
        >{@html icon(RotateCcw, { size: 15 })}<span>{t(retryLabelKey)}</span></button
      >{/if}
    {#if onCompact}<button type="button" onclick={onCompact}
        >{@html icon(Minimize, { size: 15 })}<span>{t('piSession.compact')}</span></button
      >{/if}
    {#if onChooseModel && !modelUnavailable}{@render chooseModel()}{/if}
  </div>
{/snippet}

{#if actionsOnly}
  {#if hasActions}{@render actions(true)}{/if}
{:else}
  <div class="reply-error" class:reply-interrupted={interrupted}>
    {#if error}
      <details class="reply-error-details">
        <summary class="reply-error-header">
          {@render heading()}
          <span class="reply-error-chevron">{@html icon(ChevronRight, { size: 15 })}</span>
        </summary>
        <div class="reply-error-detail">{error}</div>
      </details>
    {:else}
      <div class="reply-error-header">{@render heading()}</div>
    {/if}
    {#if hasActions}{@render actions()}{/if}
  </div>
{/if}

<style>
  .reply-error {
    width: min(100%, 34rem);
    box-sizing: border-box;
    border: 1px solid var(--dim);
    background: var(--surface);
    border-radius: 12px;
    margin-block: 8px;
  }
  .reply-error-header {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 44px;
    padding: 8px 11px;
    list-style: none;
    color: var(--text);
  }
  summary {
    cursor: pointer;
    border-radius: 11px;
  }
  summary:hover {
    background: var(--hover);
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .reply-error-mark,
  .reply-error-chevron {
    display: grid;
    place-items: center;
    flex: none;
  }
  .reply-error-mark {
    width: 25px;
    height: 25px;
    border-radius: 8px;
    color: var(--error);
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .reply-interrupted .reply-error-mark {
    color: var(--text-soft);
  }
  .reply-error-heading {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 9px;
    min-width: 0;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .reply-error-title {
    font-size: 13px;
    font-weight: 650;
  }
  small {
    max-width: 100%;
    color: var(--text-soft);
    font-size: 12px;
  }
  .reply-error-chevron {
    color: var(--text-soft);
  }
  details[open] .reply-error-chevron {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: no-preference) {
    .reply-error-chevron {
      transition: transform 150ms ease;
    }
  }
  .reply-error-detail {
    border-top: 1px solid var(--dim);
    padding: 9px 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 240px;
    overflow-y: auto;
    color: var(--text-soft);
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
  .reply-error-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 9px;
    color: var(--text-soft);
    font-size: 13px;
    line-height: 1.35;
  }
  .reply-error-details[open] + .reply-error-actions {
    padding-top: 8px;
  }
  .reply-error-actions-standalone {
    margin-block: -3px 12px;
    margin-inline-start: 16px;
    padding: 0;
  }
  .reply-error-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    max-width: 100%;
    padding: 3px 9px;
    border: 1px solid var(--dim);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .reply-error-actions button :global(svg) {
    flex: none;
  }
  .reply-error-actions button span {
    overflow-wrap: anywhere;
  }
  .reply-error-actions button:is(:hover, :focus-visible, :active) {
    background: var(--hover);
    color: var(--text);
  }
  .reply-error-actions .reply-action-primary {
    background: var(--surface-2, var(--hover));
    color: var(--text);
  }
  .reply-error-actions .reply-action-primary span {
    font-weight: 650;
  }
  .reply-error-actions .reply-action-primary:is(:hover, :focus-visible, :active) {
    background: color-mix(in srgb, var(--text) 10%, var(--surface));
  }
  @media (pointer: coarse) {
    .reply-error-actions button {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>

<script>
  import { icon, CircleAlert, ChevronRight, Layers, RotateCcw } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let { error, model = '', onChooseModel = null, onRetry = null } = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<details class="reply-error">
  <summary>
    {@html icon(CircleAlert, { size: 14 })}
    <span>{t('activity.failed')}</span>
    {#if model}<small>{model}</small>{/if}
    <span class="reply-error-chevron" aria-hidden="true"
      >{@html icon(ChevronRight, { size: 14 })}</span
    >
  </summary>
  {#if error}<div class="reply-error-detail">{error}</div>{/if}
</details>
{#if onChooseModel || onRetry}
  <div class="reply-error-actions">
    {#if onChooseModel}<button
        type="button"
        aria-label={t('models.title')}
        title={t('models.title')}
        onclick={onChooseModel}
      >
        {@html icon(Layers, { size: 15 })}
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
  details {
    max-width: 100%;
    width: fit-content;
    border: 1px solid var(--dim);
    background: var(--surface);
    border-radius: 9px;
    font-size: 12px;
    margin: 8px 0;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 7px;
    list-style: none;
    padding: 9px 10px;
    min-height: 38px;
    cursor: pointer;
    color: var(--error);
  }
  summary::-webkit-details-marker {
    display: none;
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
</style>

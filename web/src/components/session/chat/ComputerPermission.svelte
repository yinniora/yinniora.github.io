<script>
  import { onMount } from 'svelte';
  import { icon, ShieldCheck } from '../../../shared/icons.js';
  import { t } from '../../../shared/i18n.js';

  let { sessionId, model = null, running = false, children } = $props();
  let details = $state(null);
  let status = $state(null);
  let busy = $state(false);
  let error = $state('');
  let controller;
  let polling = false;
  let mutation = 0;
  const modes = ['off', 'ask', 'allow'];
  const waiting = $derived(status?.requests?.[0] ?? null);

  async function load(update) {
    if (!controller || controller.signal.aborted || (update ? busy : polling || busy)) return;
    const scope = controller;
    const version = update ? ++mutation : mutation;
    if (update) {
      busy = true;
      error = '';
    } else {
      polling = true;
    }
    try {
      const response = await fetch('/api/computer-use?id=' + encodeURIComponent(sessionId), {
        signal: scope.signal,
        ...(update && {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        }),
      });
      const result = await response.json();
      if (scope.signal.aborted || version !== mutation) return;
      if (!response.ok) {
        const message =
          update?.action === 'answer' && response.status === 409
            ? 'computer.expired'
            : 'computer.unavailable';
        throw new Error(t(message));
      }
      status = result;
      error = '';
    } catch (err) {
      if (!scope.signal.aborted && (update || details?.open)) {
        error = err instanceof SyntaxError ? t('computer.unavailable') : err.message;
      }
    } finally {
      if (update) busy = false;
      else polling = false;
    }
  }

  function setMode(mode) {
    if (mode === 'allow' && !window.confirm(t('computer.confirmAllow'))) return;
    void load({ action: 'mode', mode });
  }

  onMount(() => {
    controller = new AbortController();
    if (running) void load();
    const timer = setInterval(() => {
      if (running || waiting || details?.open) void load();
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icon -->
{#if waiting}
  <div class="computer-approval" role="region" aria-label={t('computer.waiting')}>
    <div class="approval-heading" role="status">
      {@html icon(ShieldCheck, { size: 17 })}
      <strong>{t('computer.waiting')}</strong>
    </div>
    <details>
      <summary><code>{waiting.tool}</code></summary>
      <pre>{waiting.detail}</pre>
    </details>
    <div class="approval-actions">
      <button
        type="button"
        class="approval-allow"
        disabled={busy}
        onclick={() => load({ action: 'answer', requestID: waiting.id, allow: true })}
        >{t('computer.allowOnce')}</button
      >
      <button
        type="button"
        disabled={busy}
        onclick={() => load({ action: 'answer', requestID: waiting.id, allow: false })}
        >{t('computer.deny')}</button
      >
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
{/if}

{#snippet permissionControl()}
  <details class="computer-permission" bind:this={details} ontoggle={() => details?.open && load()}>
    <summary
      class="pi-chat-icon-button"
      aria-label={t('computer.title')}
      title={t('computer.title')}
    >
      {@html icon(ShieldCheck, { size: 19 })}
      {#if waiting}<span class="pending-dot" aria-label={t('computer.waiting')}></span>{/if}
    </summary>
    <div class="computer-panel">
      <strong>{t('computer.title')}</strong>
      {#if status}
        <p>
          {t(
            status.loaded
              ? 'computer.loaded'
              : status.checked
                ? 'computer.notLoaded'
                : status.installed
                  ? 'computer.installed'
                  : 'computer.notDetected',
          )}
        </p>
        {#if model}
          <p>
            {t(model.supportsTools ? 'computer.modelTools' : 'computer.modelUnknown')}
            {t(model.input?.includes('image') ? 'computer.modelImages' : 'computer.modelText')}
          </p>
        {/if}
        <div class="computer-modes" aria-label={t('computer.sessionModes')}>
          {#each modes as mode (mode)}
            <button
              type="button"
              disabled={busy}
              aria-pressed={status.mode === mode}
              onclick={() => setMode(mode)}>{t('computer.mode.' + mode)}</button
            >
          {/each}
        </div>
        {#if !waiting && !status.loaded}
          <button type="button" disabled={busy || running} onclick={() => load({ action: 'check' })}
            >{t('computer.check')}</button
          >
        {/if}
      {:else if !error}
        <p>{t('computer.loading')}</p>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  </details>
{/snippet}

{@render children(permissionControl)}

<svelte:window
  onclick={(event) => {
    if (details?.open && !details.contains(event.target)) details.open = false;
  }}
  onkeydown={(event) => {
    if (details?.open && event.key === 'Escape') details.open = false;
  }}
/>

<style>
  .computer-permission > summary {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 36px;
    min-height: 36px;
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .pending-dot {
    position: absolute;
    top: 6px;
    right: 5px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .computer-panel {
    position: absolute;
    right: 8px;
    bottom: calc(100% + 6px);
    z-index: 16;
    width: min(324px, calc(100vw - 34px));
    max-height: min(325px, 55dvh);
    overflow: auto;
    box-sizing: border-box;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 12px;
    padding: 12px;
    box-shadow: 0 8px 30px #0004;
    font-size: 0.86rem;
    white-space: normal;
  }
  p {
    margin: 6px 0 10px;
  }
  .computer-modes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  button {
    padding: 6px 8px;
    border: 1px solid var(--dim);
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--accent);
  }
  .computer-approval {
    display: grid;
    gap: 7px;
    padding: 10px;
    margin: 6px 0;
    border: 1px solid color-mix(in srgb, var(--warning) 52%, var(--dim));
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
  }
  .approval-heading,
  .approval-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .approval-heading {
    color: var(--warning);
  }
  .approval-actions {
    justify-content: end;
    flex-wrap: wrap;
  }
  .approval-actions button {
    min-height: 40px;
  }
  .approval-allow {
    background: var(--text);
    color: var(--body-bg);
  }
  .computer-approval summary {
    cursor: pointer;
    color: var(--text-soft);
  }
  .computer-approval pre {
    max-height: 90px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

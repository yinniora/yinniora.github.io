<script>
  import { onMount } from 'svelte';
  import { ChevronRight, icon } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { backState, handleNavClick } from '../../shared/navigation.js';
  let {
    client = typeof window !== 'undefined' ? window.__PI_REMOTE_CLIENT__ : null,
    fallback = '',
    href = '',
  } = $props();
  let current = $state('disconnected');
  let transport = $state('');
  let timer;
  const state = $derived(client ? current : fallback);
  const label = $derived(
    transport && ['connected', 'syncing', 'loading'].includes(state)
      ? `${t(`connection.${state}`)} · ${t(`connection.${transport}`)}`
      : t(`connection.${state}`),
  );
  onMount(() => {
    if (!client) return;
    current = client.status;
    transport = client.transport || '';
    const update = (event) => {
      transport = client.transport || '';
      clearTimeout(timer);
      if (event.detail === 'loading') timer = setTimeout(() => (current = client.status), 200);
      else current = event.detail;
    };
    client.addEventListener('status', update);
    return () => {
      clearTimeout(timer);
      client.removeEventListener('status', update);
    };
  });
</script>

{#snippet status()}
  <span
    class="connection-status"
    data-state={state}
    role="status"
    aria-live="polite"
    title={t(`connection.${state}`)}
  >
    <i aria-hidden="true"></i><span class="status-label">{label}</span>
  </span>
{/snippet}

{#if state}
  {#if href}
    <a
      {href}
      class="connection-status-link"
      aria-label={`${label} · ${t('hub.connections')}`}
      onclick={(event) =>
        handleNavClick(event, href, { state: { ...backState(), fromHomeStatus: true } })}
    >
      {@render status()}
      <span class="connection-chevron" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
        {@html icon(ChevronRight, { size: 13 })}
      </span>
    </a>
  {:else}
    {@render status()}
  {/if}
{/if}

<style>
  .connection-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 400;
    line-height: 16px;
    color: var(--text-soft, #777);
    white-space: nowrap;
    letter-spacing: 0;
    vertical-align: middle;
  }
  .connection-status-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    min-height: 32px;
    padding-inline: 9px 6px;
    border: 1px solid var(--dim);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-soft);
    text-decoration: none;
    transition:
      background-color 150ms ease,
      border-color 150ms ease;
  }
  .connection-status-link:hover {
    background: var(--hover);
    border-color: var(--workspace-edge);
  }
  .connection-status-link .connection-status {
    min-width: 0;
    font-size: 12px;
    font-weight: 550;
  }
  .connection-status-link .status-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .connection-chevron {
    display: flex;
    flex: none;
  }
  @media (max-width: 900px) {
    .connection-status-link {
      min-height: 44px;
    }
  }
  i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #909090;
    flex-shrink: 0;
  }
  [data-state='connected'] i {
    background: #35a46a;
  }
  [data-state='loading'] i,
  [data-state='syncing'] i {
    background: #5c96df;
  }
  [data-state='connecting'] i,
  [data-state='reconnecting'] i {
    background: #d69d38;
  }
  [data-state='disconnected'] i,
  [data-state='blocked'] i {
    background: #cf6d6d;
  }
  [data-state='loading'] i,
  [data-state='syncing'] i,
  [data-state='connecting'] i,
  [data-state='reconnecting'] i {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    i {
      animation: none !important;
    }
    .connection-status-link {
      transition: none;
    }
  }
</style>

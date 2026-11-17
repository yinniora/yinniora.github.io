<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  let {
    client = typeof window !== 'undefined' ? window.__PI_REMOTE_CLIENT__ : null,
    fallback = '',
  } = $props();
  let current = $state('disconnected');
  let transport = $state('');
  let timer;
  const state = $derived(client ? current : fallback);
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

{#if state}
  <span
    class="connection-status"
    data-state={state}
    role="status"
    aria-live="polite"
    title={t(`connection.${state}`)}
  >
    <i aria-hidden="true"></i><span
      >{t(
        `connection.${state}`,
      )}{#if transport && ['connected', 'syncing', 'loading'].includes(state)}
        · {t(`connection.${transport}`)}{/if}</span
    >
  </span>
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
  }
</style>

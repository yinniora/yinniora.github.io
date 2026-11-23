<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import {
    Check,
    ChevronRight,
    Link2,
    Loader,
    LogOut,
    Monitor,
    RotateCcw,
    Server,
    Zap,
    icon,
  } from '../../shared/icons.js';

  const remoteClient = typeof window !== 'undefined' ? window.__PI_REMOTE_CLIENT__ : null;
  const desktopMode = typeof window !== 'undefined' ? window.__YUGOPI_WORKSPACE_MODE__ : null;
  const mobile =
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
  const titleID = $props.id();
  const modes = [
    { id: 'auto', icon: Link2, labelKey: 'remote.auto', hintKey: 'remote.autoHint' },
    { id: 'tailscale', icon: Zap, labelKey: 'remote.tailscale', hintKey: 'remote.tailscaleHint' },
    { id: 'vps', icon: Server, labelKey: 'remote.vps', hintKey: 'remote.vpsHint' },
  ];
  let items = $state([]);
  let preference = $state(remoteClient?.preference || 'auto');
  let busy = $state(false);
  let loading = $state(!remoteClient);
  let switching = $state('');
  let error = $state('');
  let loadFailed = $state(false);

  function refreshRemoteModes() {
    const { lanUrl, directUrl, signalUrl } = remoteClient.config || {};
    if (signalUrl) {
      items = modes;
      preference = remoteClient.preference;
    } else if (directUrl || (lanUrl && remoteClient.nativeLANSocket)) {
      const lanOnly = lanUrl && remoteClient.nativeLANSocket && !directUrl;
      items = [
        {
          ...modes[0],
          icon: lanOnly ? Link2 : Zap,
          labelKey: lanOnly ? 'remoteSettings.lan' : 'remote.tailscale',
          hintKey: lanOnly ? '' : 'remote.tailscaleHint',
        },
      ];
      preference = 'auto';
    } else {
      items = [];
    }
  }

  async function load() {
    loading = true;
    error = '';
    loadFailed = false;
    try {
      const { connections } = await getJSON('/api/connections');
      items =
        Array.isArray(connections) && connections.length
          ? connections
          : [{ id: 'local', kind: 'local', url: window.location.origin }];
    } catch (failure) {
      error = failure.message || t('hub.connectionFailed');
      loadFailed = true;
    } finally {
      loading = false;
    }
  }

  function current(item) {
    return remoteClient ? preference === item.id : new URL(item.url).origin === location.origin;
  }

  async function connect(item) {
    busy = true;
    switching = item.id;
    error = '';
    try {
      if (remoteClient) {
        await remoteClient.reconnect(item.id);
        return;
      }
      const data = await postJSON('/api/connect', { target: item.id, session: '' });
      if (!data.url) throw new Error(t('hub.connectionFailed'));
      window.location.assign(data.url);
    } catch (failure) {
      error = failure.message || t('hub.connectionFailed');
    } finally {
      if (remoteClient) preference = remoteClient.preference;
      switching = '';
      busy = false;
    }
  }

  async function logout() {
    busy = true;
    error = '';
    try {
      await postJSON('/api/logout', {});
      window.location.assign('/');
    } catch (failure) {
      error = failure.message;
      busy = false;
    }
  }

  onMount(() => {
    if (!remoteClient) {
      void load();
      return;
    }
    refreshRemoteModes();
    remoteClient.addEventListener('configuration', refreshRemoteModes);
    return () => remoteClient.removeEventListener('configuration', refreshRemoteModes);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<section class="connection-settings" data-connection-settings aria-labelledby={titleID}>
  <div>
    <h2 id={titleID}>{t('remote.transport')}</h2>
    {#if items.length > 1}<p class="connection-intro">{t('hub.connectionHint')}</p>{/if}
  </div>

  {#if error}
    <div class="connection-error" role="alert">
      <p>{error}</p>
      {#if loadFailed}<button type="button" onclick={load}>{t('common.retry')}</button>{/if}
    </div>
  {/if}

  {#if loading}
    <p class="connection-progress" role="status">{t('hub.loading')}</p>
  {:else if items.length}
    <div class="connection-modes" role="group" aria-labelledby={titleID} aria-busy={!!switching}>
      {#each items as item (item.id)}
        {@const selected = current(item)}
        {@const name = item.labelKey
          ? t(item.labelKey)
          : item.name || t('hub.connection.' + item.kind)}
        {@const hint = item.hintKey
          ? t(item.hintKey)
          : item.description || (remoteClient ? '' : t('hub.connection.' + item.kind + '.hint'))}
        <button
          type="button"
          class="connection-option"
          class:current={selected}
          aria-current={selected ? 'true' : undefined}
          disabled={busy ||
            (selected && !(remoteClient && error)) ||
            (item.kind === 'local' && mobile)}
          onclick={() => connect(item)}
        >
          <span class="connection-icon" aria-hidden="true"
            >{@html icon(item.icon || Link2, { size: 19 })}</span
          >
          <span class="connection-option-text">
            <strong>{name}</strong>
            {#if switching === item.id}
              <span class="connection-mark spinning" aria-hidden="true">
                {@html icon(Loader, { size: 18 })}
              </span>
            {:else if selected}
              <span class="connection-mark selected">
                {@html icon(Check, { size: 16 })}<span>{t('hub.current')}</span>
              </span>
            {/if}
            {#if hint}<small>{hint}</small>{/if}
          </span>
        </button>
      {/each}
    </div>
    {#if switching}<p class="connection-progress" role="status">
        {t('connection.reconnecting')}
      </p>{/if}
  {/if}

  <div class="connection-actions">
    {#if desktopMode}
      <button type="button" onclick={() => desktopMode.open()}>
        <span aria-hidden="true">{@html icon(Monitor, { size: 18 })}</span>
        <span>{desktopMode.label}</span>
        <span class="action-chevron" aria-hidden="true"
          >{@html icon(ChevronRight, { size: 16 })}</span
        >
      </button>
    {/if}
    {#if remoteClient}
      <button type="button" disabled={busy} onclick={() => window.location.assign('/?pairing=1')}>
        <span aria-hidden="true">{@html icon(RotateCcw, { size: 18 })}</span>
        <span>{t('remote.repair')}</span>
        <span class="action-chevron" aria-hidden="true"
          >{@html icon(ChevronRight, { size: 16 })}</span
        >
      </button>
    {/if}
    <button type="button" class="connection-logout" disabled={busy || loading} onclick={logout}>
      <span aria-hidden="true">{@html icon(LogOut, { size: 18 })}</span>
      <span>{t('hub.logout')}</span>
    </button>
  </div>
</section>

<style>
  .connection-settings {
    display: grid;
    gap: 14px;
    max-width: 610px;
    margin: 2px auto 0;
    color: var(--text);
    font-family: var(--font-sans);
  }
  h2 {
    margin: 0;
    font-size: 19px;
    line-height: 1.35;
    font-weight: 650;
  }
  .connection-intro,
  .connection-progress {
    margin: 6px 0 0;
    color: var(--text-soft);
    font-size: 13px;
    line-height: 1.55;
  }
  .connection-modes,
  .connection-actions {
    display: grid;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--dim);
    border-radius: 16px;
    background: var(--surface);
  }
  .connection-option,
  .connection-actions button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 11px;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    border-radius: 11px;
    text-align: start;
    cursor: pointer;
    transition:
      background-color 150ms ease,
      color 150ms ease;
  }
  .connection-option {
    grid-template-columns: auto minmax(0, 1fr);
    min-height: 65px;
    padding: 10px;
  }
  .connection-option.current {
    background: color-mix(in srgb, var(--composer-primary, var(--accent)) 10%, var(--surface));
  }
  .connection-option:disabled,
  .connection-actions button:disabled {
    cursor: default;
  }
  .connection-option:disabled:not(.current),
  .connection-actions button:disabled {
    opacity: 0.65;
  }
  @media (hover: hover) {
    .connection-option:enabled:hover,
    .connection-actions button:enabled:hover {
      background: var(--surface-2);
    }
    .connection-actions .connection-logout:enabled:hover {
      background: var(--danger-surface);
    }
  }
  .connection-option:enabled:active,
  .connection-actions button:enabled:active {
    background: var(--hover);
  }
  .connection-icon,
  .connection-mark,
  .connection-actions button > span:first-child,
  .action-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .connection-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text-soft);
  }
  .current .connection-icon {
    background: var(--surface);
    color: var(--composer-primary, var(--accent));
  }
  .connection-option-text {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 3px 8px;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.4;
  }
  .connection-option-text strong {
    font-size: 15px;
    font-weight: 650;
  }
  .connection-option-text small {
    grid-column: 1 / -1;
    color: var(--text-soft);
    font-size: 13px;
  }
  .connection-mark {
    gap: 3px;
    color: var(--composer-primary, var(--accent));
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .connection-mark :global(svg) {
    flex: none;
  }
  .spinning {
    animation: connection-spin 0.9s linear infinite;
  }
  @keyframes connection-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .connection-progress {
    margin: 0;
  }
  .connection-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--danger-surface);
    color: var(--danger);
    font-size: 13px;
  }
  .connection-error p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .connection-error button {
    flex: none;
    min-height: 36px;
    padding-inline: 8px;
  }
  .connection-actions {
    margin-top: 4px;
  }
  .connection-actions button {
    min-height: 49px;
    padding: 9px 12px;
    font-size: 14px;
  }
  .action-chevron {
    color: var(--text-soft);
  }
  .connection-actions .connection-logout {
    color: var(--danger);
  }
  @media (max-width: 360px) {
    .connection-mark.selected > span {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .connection-option,
    .connection-actions button {
      transition: none;
    }
    .spinning {
      animation: none;
    }
  }
</style>

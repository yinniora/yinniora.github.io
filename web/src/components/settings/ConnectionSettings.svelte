<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { icon, Link2 } from '../../shared/icons.js';

  // The connection switcher lives in Settings; the home menu keeps Models in its place.
  let items = $state([]);
  let busy = $state(true);
  let error = $state('');
  let revision = $state(0);
  const remoteClient = typeof window !== 'undefined' ? window.__PI_REMOTE_CLIENT__ : null;
  const directOnly = remoteClient?.config?.directUrl && !remoteClient.config.signalUrl;
  const mobile =
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/.test(navigator.userAgent);

  function current(item) {
    void revision; // re-evaluate after an in-app reconnect
    if (remoteClient)
      return (
        remoteClient.preference ===
        (item.kind === 'tailscale' ? 'tailscale' : item.kind === 'remote' ? 'vps' : 'auto')
      );
    return new URL(item.url).origin === location.origin;
  }
  function labelKey(item) {
    return item.kind === 'tailscale'
      ? 'remote.tailscale'
      : item.kind === 'remote'
        ? 'remote.vps'
        : item.kind === 'auto'
          ? 'remote.auto'
          : '';
  }

  async function load() {
    busy = true;
    try {
      if (directOnly) return;
      const data = await getJSON('/api/connections');
      items = (Array.isArray(data.connections) ? data.connections : []).filter(
        (item) => !remoteClient || item.kind !== 'local',
      );
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  async function connect(id) {
    busy = true;
    error = '';
    try {
      const data = await postJSON('/api/connect', { target: id, session: '' });
      if (data.clientManaged && remoteClient) {
        await remoteClient.reconnect(
          data.transport === 'remote'
            ? 'vps'
            : data.transport === 'tailscale'
              ? 'tailscale'
              : 'auto',
        );
        revision += 1;
        return;
      }
      if (!data.url) throw new Error(t('hub.connectionFailed'));
      window.location.assign(data.url);
    } catch (e) {
      error = e.message || t('hub.connectionFailed');
    } finally {
      busy = false;
    }
  }

  async function logout() {
    busy = true;
    try {
      await postJSON('/api/logout', {});
      window.location.assign('/');
    } catch (e) {
      error = e.message;
      busy = false;
    }
  }

  onMount(load);
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<section class="settings-section connection-settings" data-connection-settings>
  <div class="settings-section-title">{t('hub.connections')}</div>
  <p class="connection-hint">{t(directOnly ? 'remote.tailscaleHint' : 'hub.connectionHint')}</p>
  {#if error}<p class="connection-error" role="alert">{error}</p>{/if}
  {#each items as item (item.id)}
    {@const key = labelKey(item)}
    <button
      type="button"
      class="connection-option"
      class:current={current(item)}
      disabled={busy || current(item) || (item.kind === 'local' && mobile)}
      onclick={() => connect(item.id)}
    >
      {@html icon(Link2, { size: 18 })}
      <span
        ><strong>{key ? t(key) : item.name || t('hub.connection.' + item.kind)}</strong><small
          >{key
            ? t(key + 'Hint')
            : item.description || t('hub.connection.' + item.kind + '.hint')}</small
        ></span
      >
      {#if current(item)}<em>{t('hub.current')}</em>{/if}
    </button>
  {:else}
    {#if busy}<p class="connection-hint">{t('hub.loading')}</p>{/if}
  {/each}
  <p class="connection-hint">{t('hub.hostAwake')}</p>
  <div class="connection-actions">
    {#if remoteClient}<button
        type="button"
        class="btn-secondary"
        onclick={() => window.location.assign('/?pairing=1')}>{t('remote.repair')}</button
      >{/if}
    <button type="button" class="btn-secondary connection-logout" disabled={busy} onclick={logout}
      >{t('hub.logout')}</button
    >
  </div>
</section>

<style>
  .connection-hint {
    margin: 0 0 14px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .connection-error {
    margin: 0 0 14px;
    color: var(--danger, #e5484d);
    font-size: 13px;
  }
  .connection-option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    width: 100%;
    margin-bottom: 12px;
    padding: 14px;
    text-align: left;
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 12px;
    cursor: pointer;
  }
  .connection-option:disabled {
    cursor: default;
  }
  .connection-option:disabled:not(.current) {
    opacity: 0.55;
  }
  .connection-option.current {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }
  .connection-option :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--muted);
  }
  .connection-option > span {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .connection-option strong {
    font-size: 14px;
  }
  .connection-option small {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .connection-option em {
    flex: none;
    color: var(--accent);
    font-size: 12px;
    font-style: normal;
  }
  .connection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .connection-logout {
    color: var(--danger, #e5484d);
  }
</style>

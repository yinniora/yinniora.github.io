<script>
  import { onMount, tick } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { navigate } from '../../shared/navigation.js';
  import { setSessionTitle } from '../../session/session-title.svelte.js';
  import { icon, X, Pencil, Trash2, Download, Link2 } from '../../shared/icons.js';

  let view = $state('');
  let id = $state('');
  let name = $state('');
  let items = $state([]);
  let busy = $state(false);
  let error = $state('');
  let purgeId = $state('');
  let dialog;
  let previousFocus;

  function currentConnection(item) {
    const client = window.__PI_REMOTE_CLIENT__;
    if (client)
      return (
        client.preference ===
        (item.kind === 'tailscale' ? 'tailscale' : item.kind === 'remote' ? 'vps' : 'auto')
      );
    return new URL(item.url).origin === location.origin;
  }
  function connectionKey(item) {
    return item.kind === 'tailscale'
      ? 'remote.tailscale'
      : item.kind === 'remote'
        ? 'remote.vps'
        : item.kind === 'auto'
          ? 'remote.auto'
          : '';
  }

  function close() {
    view = '';
    dialog?.close();
    previousFocus?.focus?.();
  }

  async function load() {
    if (view !== 'trash' && view !== 'connections') return;
    busy = true;
    try {
      const data = await getJSON(view === 'trash' ? '/api/trash' : '/api/connections');
      const nextItems = view === 'trash' ? data.sessions : data.connections;
      items = (Array.isArray(nextItems) ? nextItems : []).filter(
        (item) => view !== 'connections' || !window.__PI_REMOTE_CLIENT__ || item.kind !== 'local',
      );
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  async function run(action, itemId = id) {
    busy = true;
    error = '';
    try {
      if (action === 'rename') {
        if (!name.trim()) {
          error = t('hub.nameRequired');
          return;
        }
        await postJSON('/api/rename-session?id=' + encodeURIComponent(id), { name: name.trim() });
        if (new URLSearchParams(location.search).get('id') === id) setSessionTitle(name.trim());
        window.dispatchEvent(new CustomEvent('pi:hub-updated'));
        close();
      } else if (action === 'delete' || action === 'restore' || action === 'purge') {
        await postJSON('/api/trash', {
          id: itemId,
          restore: action === 'restore',
          permanent: action === 'purge',
        });
        window.dispatchEvent(new CustomEvent('pi:hub-updated'));
        purgeId = '';
        if (action === 'restore' || (action === 'purge' && view === 'trash')) {
          await load();
        } else {
          close();
          navigate('/');
        }
      } else if (action === 'connect') {
        const data = await postJSON('/api/connect', {
          target: itemId,
          session: new URLSearchParams(location.search).get('id') || '',
        });
        if (data.clientManaged && window.__PI_REMOTE_CLIENT__) {
          await window.__PI_REMOTE_CLIENT__.reconnect(
            data.transport === 'remote'
              ? 'vps'
              : data.transport === 'tailscale'
                ? 'tailscale'
                : 'auto',
          );
          close();
          return;
        }
        if (!data.url) throw new Error(t('hub.connectionFailed'));
        window.location.assign(data.url);
      } else if (action === 'pair-again') {
        window.location.assign('/?pairing=1');
      } else if (action === 'logout') {
        await postJSON('/api/logout', {});
        window.location.assign('/');
      }
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const open = async (event) => {
      previousFocus = document.activeElement;
      view = event.detail?.view || 'connections';
      id = event.detail?.id || '';
      name = event.detail?.name || '';
      error = '';
      items = [];
      purgeId = '';
      await tick();
      if (!dialog.open) dialog.showModal();
      await load();
    };
    window.addEventListener('pi:hub', open);
    return () => window.removeEventListener('pi:hub', open);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  bind:this={dialog}
  class="hub-dialog"
  oncancel={close}
  onclick={(e) => {
    if (e.target === dialog) close();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') close();
  }}
>
  <div class="hub-sheet">
    <header>
      <h2>{t(`hub.${view || 'connections'}`)}</h2>
      <button class="hub-icon" aria-label={t('common.close')} onclick={close}
        >{@html icon(X, { size: 20 })}</button
      >
    </header>
    {#if error}<p class="hub-error" role="alert">{error}</p>{/if}
    {#if view === 'connections' && window.__PI_REMOTE_CLIENT__}<button
        type="button"
        class="btn-secondary"
        onclick={() => run('pair-again')}>{t('remote.repair')}</button
      >{/if}
    {#if view === 'session'}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          run('rename');
        }}
      >
        <label for="hub-session-name">{t('hub.sessionName')}</label>
        <input id="hub-session-name" bind:value={name} maxlength="200" autocomplete="off" />
        <button type="submit" disabled={busy || !name.trim()}
          >{@html icon(Pencil)}{t('common.save')}</button
        >
      </form>
      <a class="hub-action" href={'/api/export-markdown?id=' + encodeURIComponent(id)} download
        >{@html icon(Download)}{t('hub.export')}</a
      >
      <p class="hub-hint">{t('hub.deleteHint')}</p>
      <button class="hub-action hub-danger" disabled={busy} onclick={() => run('delete')}
        >{@html icon(Trash2)}{t('hub.delete')}</button
      >
      {#if purgeId === id}
        <div class="hub-purge-confirm" role="alert">
          <p>{t('hub.purgeWarning')}</p>
          <div class="hub-confirm-buttons">
            <button disabled={busy} onclick={() => (purgeId = '')}>{t('common.cancel')}</button>
            <button class="hub-danger" disabled={busy} onclick={() => run('purge')}
              >{t('hub.purgeConfirm')}</button
            >
          </div>
        </div>
      {:else}
        <button
          class="hub-action hub-danger hub-purge-direct"
          disabled={busy}
          onclick={() => (purgeId = id)}>{@html icon(Trash2)}{t('hub.purge')}</button
        >
      {/if}
    {:else if view === 'trash'}
      <p class="hub-hint">{t('hub.trashHint')}</p>
      {#if busy}<p role="status">{t('hub.loading')}</p>
      {:else if !items.length}<p class="hub-empty">{t('hub.emptyTrash')}</p>{/if}
      {#each items as item (item.id)}
        <div class="hub-row">
          <div class="hub-trash-info">
            <strong>{item.name || item.id}</strong><small title={item.project}
              >{item.project?.split('/').filter(Boolean).at(-1)}</small
            ><small>{new Date(item.deletedAt).toLocaleString()}</small>
          </div>
          <div class="hub-trash-actions">
            <button disabled={busy} onclick={() => run('restore', item.id)}
              >{t('hub.restore')}</button
            >
            {#if purgeId === item.id}
              <p class="hub-error">{t('hub.purgeWarning')}</p>
              <button class="hub-danger" disabled={busy} onclick={() => run('purge', item.id)}
                >{t('hub.purgeConfirm')}</button
              >
              <button disabled={busy} onclick={() => (purgeId = '')}>{t('common.cancel')}</button>
            {:else}
              <button class="hub-danger" disabled={busy} onclick={() => (purgeId = item.id)}
                >{t('hub.purge')}</button
              >
            {/if}
          </div>
        </div>
      {/each}
    {:else if view === 'connections'}
      <p class="hub-hint">{t('hub.connectionHint')}</p>
      {#each items as item (item.id)}
        <button
          class="hub-connection"
          class:hub-current={currentConnection(item)}
          disabled={busy ||
            currentConnection(item) ||
            (item.kind === 'local' && /iPhone|iPad|iPod|Android/.test(navigator.userAgent))}
          onclick={() => run('connect', item.id)}
        >
          {@html icon(Link2, { size: 18 })}
          <span
            ><strong
              >{connectionKey(item)
                ? t(connectionKey(item))
                : item.name || t('hub.connection.' + item.kind)}</strong
            ><small
              >{connectionKey(item)
                ? t(connectionKey(item) + 'Hint')
                : item.description || t('hub.connection.' + item.kind + '.hint')}</small
            ></span
          >
          {#if currentConnection(item)}<small>{t('hub.current')}</small>{/if}
        </button>
      {/each}
      <p class="hub-hint">{t('hub.hostAwake')}</p>
      <button class="hub-action" disabled={busy} onclick={() => run('logout')}
        >{t('hub.logout')}</button
      >
    {/if}
  </div>
</dialog>

<style>
  .hub-dialog {
    padding: 0;
    width: min(480px, calc(100vw - 24px));
    max-height: min(85dvh, 720px);
    border: 1px solid var(--dim);
    border-radius: 18px;
    background: var(--surface);
    color: var(--text, #eee);
    box-shadow: 0 24px 80px #0008;
    font-family: var(--font-sans);
    font-size: 13px;
  }
  .hub-dialog::backdrop {
    background: #0008;
    backdrop-filter: blur(4px);
  }
  .hub-sheet {
    padding: 22px;
    overflow-wrap: anywhere;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 20px;
    margin: 0;
  }
  button,
  .hub-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    min-height: 44px;
    padding: 9px 14px;
    color: inherit;
    background: var(--surface-2);
    border: 1px solid var(--dim);
    border-radius: 10px;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
  }
  button:hover,
  .hub-action:hover {
    filter: brightness(1.15);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hub-icon {
    padding: 9px;
    background: transparent;
    border: 0;
  }
  form {
    display: grid;
    gap: 12px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px;
    min-height: 44px;
    background: transparent;
    color: inherit;
    border: 1px solid var(--dim);
    border-radius: 9px;
    font-size: 16px;
  }
  .hub-action {
    width: 100%;
    box-sizing: border-box;
    margin-top: 16px;
  }
  .hub-danger,
  .hub-error {
    color: var(--danger);
  }
  .hub-hint,
  .hub-empty {
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted);
    margin: 16px 0;
  }
  .hub-error {
    font-size: 14px;
  }
  .hub-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--dim);
  }
  .hub-row > div {
    min-width: 0;
  }
  strong {
    display: block;
    font-size: 14px;
  }
  small {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin-top: 5px;
  }
  .hub-connection {
    width: 100%;
    justify-content: flex-start;
    text-align: left;
    margin-bottom: 12px;
    padding: 14px;
  }
  .hub-connection > span {
    flex: 1;
    min-width: 0;
  }
  @media (max-width: 600px) {
    .hub-dialog {
      margin: auto auto max(12px, env(safe-area-inset-bottom));
      max-height: 85dvh;
    }
    .hub-sheet {
      padding: 18px;
    }
  }
  .hub-trash-info {
    width: 100%;
  }
  .hub-connection {
    border-radius: 12px;
    min-height: 90px;
  }
  .hub-connection.hub-current {
    opacity: 1;
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }
  .hub-connection strong {
    font-size: 14px;
  }
  .hub-connection small {
    line-height: 1.5;
  }
  .hub-trash-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
  .hub-trash-actions p {
    width: 100%;
    text-align: right;
  }
  .hub-row {
    flex-wrap: wrap;
  }
  .hub-purge-direct {
    border-color: transparent;
    background: transparent;
    margin-top: 8px;
  }
  .hub-purge-confirm {
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--dim));
    background: color-mix(in srgb, var(--danger) 5%, var(--surface));
    border-radius: 12px;
    margin-top: 14px;
  }
  .hub-purge-confirm p {
    margin: 0 0 14px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-soft);
  }
  .hub-confirm-buttons {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>

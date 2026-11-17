<script>
  import { onMount, tick } from 'svelte';
  import { icon, ExternalLink, X } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import {
    cleanVersion,
    fetchVersionInfo,
    registerVersionController,
    renderChangelog,
    versionLabel,
  } from '../../shared/version.js';

  let { fetchImpl = null, minCheckMs = 450 } = $props();

  let info = $state(null);
  let open = $state(false);
  let busy = $state(false);
  let checking = $state(false);
  let status = $state('');
  let statusKind = $state('');
  let error = $state('');
  let dismissedUpstream = $state('');

  const effectiveFetch = $derived(fetchImpl || window.fetch.bind(window));
  const label = $derived(versionLabel(info));
  const hasUpdate = $derived(!!(info?.hasUpdate || info?.upstream?.hasUpdate));
  const showReminder = $derived(
    info?.trackingOnly && info?.upstream?.hasUpdate && info.upstream.latest !== dismissedUpstream,
  );
  const changelogHtml = $derived(renderChangelog(info?.changelog || ''));

  function applyStatus() {
    document.querySelectorAll('[data-version-status]').forEach((el) => {
      el.textContent = label;
      el.classList.toggle('has-update', hasUpdate);
    });
    document.querySelectorAll('[data-version-row]').forEach((el) => {
      el.classList.toggle('has-update', hasUpdate);
    });
  }

  $effect(() => {
    label;
    hasUpdate;
    tick().then(applyStatus);
  });

  async function refresh(force = false) {
    try {
      info = await fetchVersionInfo({ fetchImpl: effectiveFetch, force });
      error = '';
    } catch {
      // Leave current info intact for the row. The modal surfaces check errors.
      if (force) error = t('version.couldNotCheck');
    }
    applyStatus();
    return info;
  }

  function openModal() {
    status = '';
    statusKind = '';
    error = '';
    open = true;
    document.body?.classList.add('version-modal-open');
  }

  function closeModal() {
    if (busy) return;
    open = false;
    document.body?.classList.remove('version-modal-open');
  }

  function dismissReminder() {
    dismissedUpstream = info?.upstream?.latest || '';
    try {
      localStorage.setItem('yugo:upstream-dismissed', dismissedUpstream);
    } catch {}
  }

  function setStatus(message, kind = '') {
    status = message;
    statusKind = kind;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function doManualCheck() {
    checking = true;
    error = '';
    const startedAt = Date.now();
    try {
      await refresh(true);
      const elapsed = Date.now() - startedAt;
      if (elapsed < minCheckMs) await delay(minCheckMs - elapsed);
    } catch {
      error = t('version.couldNotCheck');
    } finally {
      checking = false;
    }
  }

  async function runUpdate() {
    if (busy) return;
    busy = true;
    setStatus(t('version.installing'), 'info');
    try {
      const res = await effectiveFetch('/api/update', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(t('version.restarting'), 'info');
      effectiveFetch('/api/restart', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }).catch(() => {});
      awaitReconnect();
    } catch (err) {
      setStatus(t('version.updateFailed', { error: err?.message || String(err) }), 'error');
      busy = false;
    }
  }

  function awaitReconnect() {
    setStatus(t('version.reconnecting'), 'info');
    const startedAt = Date.now();
    const maxWaitMs = 90_000;
    const tickReconnect = async () => {
      if (Date.now() - startedAt > maxWaitMs) {
        setStatus(t('version.serverNotBack'), 'error');
        busy = false;
        return;
      }
      try {
        const res = await effectiveFetch('/api/version', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {}
      setTimeout(tickReconnect, 1500);
    };
    setTimeout(tickReconnect, 2500);
  }

  function handleRowClick(e) {
    const row = e.target?.closest?.('[data-version-row]');
    if (!row || row.dataset.action === 'version') return;
    e.preventDefault();
    openModal();
  }

  onMount(() => {
    const controller = { refresh, openModal, closeModal, applyStatus };
    const unregister = registerVersionController(controller);
    document.addEventListener('click', handleRowClick);
    try {
      dismissedUpstream = localStorage.getItem('yugo:upstream-dismissed') || '';
    } catch {}
    refresh(false);
    const poll = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh(false);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      unregister();
      document.removeEventListener('click', handleRowClick);
      document.body?.classList.remove('version-modal-open');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#if showReminder && !open}
  <div class="upstream-reminder" role="status">
    <button type="button" class="reminder-open" onclick={openModal}
      >{t('version.upstreamAvailable')}</button
    >
    <button
      type="button"
      class="reminder-close"
      onclick={dismissReminder}
      aria-label={t('common.close')}>{@html icon(X, { size: 16 })}</button
    >
  </div>
{/if}

{#if open}
  <div
    class="version-modal-overlay open"
    role="presentation"
    onclick={(e) => {
      if (e.currentTarget === e.target) closeModal();
    }}
  >
    <div
      class="version-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('app.name')} ${t('common.version')}`}
    >
      <div class="version-modal-header">
        <span class="version-modal-title">{t('app.name')}</span>
        <span class="version-modal-current">{info?.current ? cleanVersion(info.current) : ''}</span>
        <button
          type="button"
          class="version-modal-close"
          aria-label={t('common.close')}
          onclick={closeModal}>{@html icon(X, { size: 16 })}</button
        >
      </div>
      <div class="version-modal-body">
        {#if !info}
          <p>{t('version.unavailable')}</p>
        {:else if info.trackingOnly}
          <p class="version-modal-lead">{t('version.trackingOnly')}</p>
          <p class="version-modal-notes">{t('version.trackingDescription')}</p>
          {#if info.upstream?.hasUpdate}
            <p><strong>{t('version.upstreamAvailable')}</strong></p>
            <p class="version-modal-notes">{t('version.patchReview')}</p>
            <a href={info.upstream.url} target="_blank" rel="noreferrer"
              >{t('version.reviewOfficialChanges')} {@html icon(ExternalLink, { size: 12 })}</a
            >
          {:else if info.upstream?.latest}
            <p>{t('version.upstreamCurrent')}</p>
          {:else}
            <p>{t('version.trackingPending')}</p>
          {/if}
          {#if info.upstream?.error}
            <p class="version-modal-notes">{t('version.couldNotCheck')}</p>
          {/if}
          {#if info.checkedAt}
            <p class="version-modal-notes">
              {t('version.lastChecked', { when: new Date(info.checkedAt).toLocaleString() })}
            </p>
          {/if}
        {:else if info.isDev}
          <p>{t('version.devBuild')}</p>
          {#if info.latest}<p class="version-modal-notes">
              {t('version.latestPublished', { version: cleanVersion(info.latest) })}
            </p>{/if}
          <p class="version-modal-notes">{t('version.devUpdateDisabled')}</p>
        {:else if info.hasUpdate}
          <p class="version-modal-lead">
            {t('version.updateAvailable')}
            <strong>{cleanVersion(info.current)} → {cleanVersion(info.latest)}</strong>
          </p>
          <div class="version-changelog">{@html changelogHtml}</div>
          {#if info.changelogUrl}
            <p class="version-modal-notes">
              <a href={info.changelogUrl} target="_blank" rel="noreferrer"
                >{t('version.releaseNotes')} {@html icon(ExternalLink, { size: 12 })}</a
              >
            </p>
          {/if}
        {:else}
          <p>{t('version.onLatest')}</p>
          {#if info.checkedAt}<p class="version-modal-notes">
              {t('version.lastChecked', { when: new Date(info.checkedAt).toLocaleString() })}
            </p>{/if}
        {/if}
      </div>
      <div
        class="version-modal-status"
        class:info={statusKind === 'info'}
        class:error={statusKind === 'error'}
        hidden={!status && !error}
      >
        {error || status}
      </div>
      <div class="version-modal-actions">
        {#if info?.hasUpdate && !info?.isDev && !info?.trackingOnly}
          <button
            type="button"
            class="version-modal-btn primary"
            disabled={busy}
            onclick={runUpdate}>{t('version.updateRestart')}</button
          >
          <button type="button" class="version-modal-btn ghost" disabled={busy} onclick={closeModal}
            >{t('version.later')}</button
          >
        {:else}
          <button
            type="button"
            class="version-modal-btn ghost"
            class:is-loading={checking}
            disabled={checking || busy}
            onclick={doManualCheck}
            >{checking ? t('version.checking') : t('version.checkForUpdates')}</button
          >
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .upstream-reminder {
    position: fixed;
    z-index: 500;
    top: max(8px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    max-width: min(420px, calc(100vw - 24px));
    align-items: center;
    border: 1px solid var(--dim);
    border-radius: 14px;
    background: var(--surface-1, var(--bg));
    box-shadow: 0 8px 28px #0002;
  }
  .upstream-reminder button {
    color: var(--text);
    background: transparent;
    border: 0;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    min-height: 44px;
  }
  .reminder-open {
    padding: 10px 14px;
    text-align: left;
  }
  .reminder-close {
    padding: 10px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
  }
</style>

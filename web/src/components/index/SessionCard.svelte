<script>
  import { openHub } from '../../shared/hub.js';
  import { icon, Ellipsis } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { hasUnseenCompletion } from '../../index/session-completions.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import { prefetchSession } from '../../routes/session-prefetch.js';
  import {
    formatRelativeTime,
    formatRunningModel,
    sessionModelLabel,
    sessionSearchText,
  } from '../../index/sessions.js';

  let { session, running = false, runningStatus = null, now = Date.now() } = $props();

  const href = $derived(`/session?id=${encodeURIComponent(session.id || '')}`);
  const title = $derived(session.name || session.id || '');
  const modelLabel = $derived(formatRunningModel(runningStatus) || sessionModelLabel(session));
  const runningModel = $derived(running ? formatRunningModel(runningStatus) : '');
  const search = $derived(sessionSearchText(session));
  const completed = $derived(!running && hasUnseenCompletion(session));

  // Start /api/session as soon as the user signals intent (hover or press), so
  // the response is usually back by the time SessionPage mounts. All three
  // events route through prefetchSession, which dedupes on session id.
  function startPrefetch() {
    if (session?.id) prefetchSession(session.id);
  }
</script>

<div class="hub-card-wrap">
  <a
    class="session-card"
    class:session-card--running={running}
    {href}
    onclick={(event) => handleNavClick(event, href)}
    onpointerenter={startPrefetch}
    onmousedown={startPrefetch}
    ontouchstart={startPrefetch}
    data-id={session.id}
    data-session-id={session.id}
    data-search={search}
  >
    <div class="session-title-row">
      <div class="session-title">{title}</div>
      <div class="session-card-flags">
        {#if completed}
          <span
            class="session-completion-dot"
            role="img"
            aria-label={t('common.done')}
            title={t('common.done')}
          ></span>
        {/if}
        {#if !session.chatAvailable}
          <span
            class="session-card-badge"
            title={session.chatDisabledReason || t('composer.disabledNotice')}
            >{t('index.viewOnly')}</span
          >
        {/if}
      </div>
    </div>
    <div class="session-project">{session.project}</div>
    <div class="session-model" data-session-model>{modelLabel}</div>
    <div class="session-meta">
      <span class="session-active-status" data-running-status
        ><span aria-hidden="true">●</span> {t('index.active')}</span
      >
      <span class="session-time" data-timestamp={session.lastActivity} title={session.lastActivity}
        >{formatRelativeTime(session.lastActivity, now)}</span
      >
      <span class="session-run-model" data-running-model>{runningModel}</span>
    </div>
  </a>

  <!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icon -->
  <button
    class="hub-card-menu"
    type="button"
    aria-label={t('hub.manageNamed', { name: title })}
    title={t('hub.session')}
    onclick={() => openHub('session', { id: session.id, name: session.name || '' })}
    >{@html icon(Ellipsis, { size: 20 })}</button
  >
</div>

<style>
  .hub-card-wrap {
    position: relative;
    min-width: 0;
  }
  .hub-card-wrap :global(.session-title-row) {
    padding-right: 38px;
  }
  .session-completion-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .hub-card-menu {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--text-muted, #aaa);
    border-radius: 10px;
    cursor: pointer;
  }
  .hub-card-menu:hover {
    background: var(--bg-secondary, #333);
  }
</style>

<script>
  import { openHub } from '../../shared/hub.js';
  import { icon, CircleAlert, Ellipsis } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { hasUnseenCompletion, markCompletionSeen } from '../../index/session-completions.js';
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
  const lastState = $derived(session.lastTurnState);
  const completed = $derived(
    !running && (!lastState || lastState === 'completed') && hasUnseenCompletion(session),
  );
  const waiting = $derived(running ? runningStatus?.waitingForInput : lastState === 'waiting');
  const failed = $derived(!running && ['failed', 'timedOut'].includes(lastState));
  const flagLabel = $derived(
    t(waiting ? 'piExtension.waiting' : failed ? `activity.${lastState}` : 'common.done'),
  );

  function openSession(event) {
    if (handleNavClick(event, href)) markCompletionSeen(session.id, session.lastCompletedAt);
  }

  // Start /api/session as soon as the user signals intent (hover or press), so
  // the response is usually back by the time SessionPage mounts. All three
  // events route through prefetchSession, which dedupes on session id.
  function startPrefetch() {
    if (session?.id) prefetchSession(session.id);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div class="hub-card-wrap">
  <a
    class="session-card"
    class:session-card--running={running}
    {href}
    onclick={openSession}
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
        {#if failed}
          <span
            class="session-problem-indicator"
            role="img"
            aria-label={flagLabel}
            title={flagLabel}
          >
            {@html icon(CircleAlert, { size: 14 })}
          </span>
        {:else if waiting || completed}
          <span
            class="session-completion-dot"
            class:waiting
            role="img"
            aria-label={flagLabel}
            title={flagLabel}
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
        ><span aria-hidden="true">●</span>
        {t(waiting ? 'piExtension.waiting' : 'index.active')}</span
      >
      <span class="session-time" data-timestamp={session.lastActivity} title={session.lastActivity}
        >{formatRelativeTime(session.lastActivity, now)}</span
      >
      <span class="session-run-model" data-running-model>{runningModel}</span>
    </div>
  </a>

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
  .session-completion-dot.waiting {
    background: var(--warning);
  }
  .session-problem-indicator {
    display: inline-flex;
    flex: none;
    color: var(--danger);
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

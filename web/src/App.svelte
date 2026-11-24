<script>
  import HubPanel from './components/shared/HubPanel.svelte';
  import DevicePanel from './components/shared/DevicePanel.svelte';
  import { createAppEvents } from './shared/app-events.js';
  import { onMount, untrack } from 'svelte';
  import SessionsPage from './routes/SessionsPage.svelte';
  import SessionPage from './routes/SessionPage.svelte';
  import SettingsPage from './routes/SettingsPage.svelte';
  import SchedulesPage from './routes/SchedulesPage.svelte';
  import NotFoundPage from './routes/NotFoundPage.svelte';
  import VersionController from './components/shared/VersionController.svelte';
  import { trackVisualViewport } from './shared/visual-viewport.js';
  import { handleNavClick } from './shared/navigation.js';
  import { t } from './shared/i18n.js';
  import { initializeSessionCompletions } from './index/session-completions.js';
  import { clearWorkspaceCache } from './shared/workspace-cache.js';
  import { resetSessionPrefetch } from './routes/session-prefetch.js';

  let {
    path: initialPath = typeof window !== 'undefined' ? window.location.pathname : '/',
    search: initialSearch = typeof window !== 'undefined' ? window.location.search : '',
  } = $props();

  // Reactive current route. Seeded from the props (so prop-driven tests stay
  // deterministic) and thereafter updated only by real navigation events, never
  // re-read on mount.
  let path = $state(untrack(() => initialPath));
  let search = $state(untrack(() => initialSearch));

  // The session route is keyed on this so a session→session navigation (same
  // pathname, different ?id=) tears down and remounts <SessionPage>, which reads
  // ?id= only at mount. Within-session navigation never changes the URL, so this
  // stays stable while reading a session.
  const sessionId = $derived(new URLSearchParams(search).get('id') || '');
  let sessionAttempt = $state(0);
  const retrySession = () => (sessionAttempt += 1);

  onMount(() => {
    const root = document.getElementById('spa-root');
    let motionTimer;
    initializeSessionCompletions();
    const stopViewport = trackVisualViewport();
    const remoteEvents = createAppEvents({
      event: 'remote-config',
      onEvent: (config) => window.__PI_REMOTE_CLIENT__?.updateConfiguration(config),
    });
    const client = window.__PI_REMOTE_CLIENT__;
    if (client) remoteEvents.connect();
    const clearCachedLists = () => {
      clearWorkspaceCache();
      resetSessionPrefetch();
    };
    const onRemoteStatus = ({ detail }) => {
      if (detail === 'blocked') clearCachedLists();
    };
    window.addEventListener('pi:hub-updated', clearCachedLists);
    client?.addEventListener('status', onRemoteStatus);
    const syncPath = (event) => {
      const nextPath = window.location.pathname;
      const nextSessionId = new URLSearchParams(window.location.search).get('id') || '';
      const routeChanged = path !== nextPath || sessionId !== nextSessionId;
      const direction =
        event?.detail?.direction ||
        (event?.type === 'popstate' && routeChanged ? (nextPath === '/' ? 'back' : 'forward') : '');
      // A view transition already animates the whole page swap.
      const viewTransition = !!document.documentElement.dataset.navMotion;
      if (root && !viewTransition && (direction === 'back' || direction === 'forward')) {
        clearTimeout(motionTimer);
        root.dataset.routeMotion = direction;
        motionTimer = setTimeout(() => delete root.dataset.routeMotion, 420);
      }
      if (routeChanged) {
        if (root) root.scrollTop = 0;
        const focused = document.activeElement;
        if (focused?.matches('input, textarea, [contenteditable]')) focused.blur();
      }
      path = nextPath;
      search = window.location.search;
    };
    window.addEventListener('popstate', syncPath);
    window.addEventListener('pi:locationchange', syncPath);
    const restorePath = (event) => {
      if (event.persisted) syncPath();
    };
    window.addEventListener('pageshow', restorePath);
    return () => {
      clearTimeout(motionTimer);
      if (root) delete root.dataset.routeMotion;
      stopViewport();
      remoteEvents.cleanup();
      window.removeEventListener('pi:hub-updated', clearCachedLists);
      client?.removeEventListener('status', onRemoteStatus);
      window.removeEventListener('popstate', syncPath);
      window.removeEventListener('pi:locationchange', syncPath);
      window.removeEventListener('pageshow', restorePath);
    };
  });
</script>

{#if path === '/'}
  <SessionsPage />
{:else if path === '/session'}
  {#key `${sessionId}:${sessionAttempt}`}
    <svelte:boundary>
      <SessionPage routeSearch={search} onRetry={retrySession} />
      {#snippet failed()}
        <div class="session-loading session-loading--error" role="alert">
          <h1>{t('session.loadFailed')}</h1>
          <button type="button" class="btn-secondary" onclick={retrySession}
            >{t('common.retry')}</button
          >
          <p>
            <a href="/" onclick={(event) => handleNavClick(event, '/')}
              >{t('session.backToSessions')}</a
            >
          </p>
        </div>
      {/snippet}
    </svelte:boundary>
  {/key}
{:else if path === '/settings'}
  <SettingsPage />
{:else if path === '/models'}
  <SettingsPage standaloneModels />
{:else if path === '/schedules'}
  <SchedulesPage />
{:else}
  <NotFoundPage />
{/if}

<VersionController />

{#key `${path}:${sessionId}`}
  <HubPanel />
  <DevicePanel />
{/key}

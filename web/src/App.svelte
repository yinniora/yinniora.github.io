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
    initializeSessionCompletions();
    const stopViewport = trackVisualViewport();
    const remoteEvents = createAppEvents({
      event: 'remote-config',
      onEvent: (config) => window.__PI_REMOTE_CLIENT__?.updateConfiguration(config),
    });
    if (window.__PI_REMOTE_CLIENT__) remoteEvents.connect();
    const syncPath = () => {
      const nextSessionId = new URLSearchParams(window.location.search).get('id') || '';
      if (path !== window.location.pathname || sessionId !== nextSessionId) {
        const root = document.getElementById('spa-root');
        if (root) root.scrollTop = 0;
        const focused = document.activeElement;
        if (focused?.matches('input, textarea, [contenteditable]')) focused.blur();
      }
      path = window.location.pathname;
      search = window.location.search;
    };
    window.addEventListener('popstate', syncPath);
    window.addEventListener('pi:locationchange', syncPath);
    const restorePath = (event) => {
      if (event.persisted) syncPath();
    };
    window.addEventListener('pageshow', restorePath);
    return () => {
      stopViewport();
      remoteEvents.cleanup();
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

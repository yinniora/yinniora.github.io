<script>
  import { onMount, tick } from 'svelte';
  import CommandPalette from '../components/shared/CommandPalette.svelte';
  import HomeMenu from '../components/index/HomeMenu.svelte';
  import IndexHeader from '../components/index/IndexHeader.svelte';
  import NewSessionModal from '../components/index/NewSessionModal.svelte';
  import ProjectsModal from '../components/index/ProjectsModal.svelte';
  import SessionsList from '../components/index/SessionsList.svelte';
  import { createStatusEvents } from '../shared/status-events.js';
  import { createAppEvents } from '../shared/app-events.js';
  import { applyRemoteSettings } from '../shared/settings-live.js';
  import { openSessionPalette, refreshSessionPalette } from '../shared/command-palette-runtime.js';
  import { setupKeyboardNav } from '../shared/keyboard-nav.js';
  import { matchesAction } from '../shared/keybindings.js';
  import { toggleTheme, syncThemeIcons } from '../shared/theme.js';
  import {
    configureSettingsSync,
    hydrateSettings,
    writeSetting,
  } from '../shared/settings-store.js';
  import { navigate, backState } from '../shared/navigation.js';
  import { getJSON } from '../shared/api.js';
  import { t } from '../shared/i18n.js';
  import {
    icon,
    Plus,
    Search,
    FolderGit2,
    Link2,
    Trash2,
    Settings,
    Send,
  } from '../shared/icons.js';
  import { openHub } from '../shared/hub.js';
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import {
    defaultCreateSession,
    defaultFetchProjects,
    defaultFetchRecent,
    defaultFetchSessions,
    defaultUpdateProject,
    layoutStorageKey,
    normalizeSession,
  } from '../index/sessions.js';

  const PAGE_SIZE = 100;

  let sessions = $state([]);
  let total = $state(0);
  let loadingMore = $state(false);
  let loading = $state(true);
  let layoutReady = $state(false);
  let layout = $state('timeline');
  const runningSessionIds = new SvelteSet();
  const runningStatuses = new SvelteMap();
  let newSessionOpen = $state(false);
  let newSessionPath = $state('');
  let recentLocations = $state([]);
  let creating = $state(false);
  let newSessionError = $state('');
  let menuOpen = $state(false);
  let projectsOpen = $state(false);
  let projects = $state([]);
  let projectsFilterEnabled = $state(false);
  let projectsBusy = $state(false);
  let projectsError = $state('');
  let refreshInflight = false;
  let homePrompt = $state('');
  let homeError = $state('');

  async function startPrompt() {
    const message = homePrompt.trim();
    if (!message || creating) return;
    creating = true;
    homeError = '';
    try {
      const connections = await getJSON('/api/connections');
      const path = connections.defaultWorkspace || recentLocations[0];
      if (!path) {
        await openNewSessionModal();
        return;
      }
      const session = await defaultCreateSession(path);
      if (!session.id) throw new Error(session.error || t('index.failedCreateSession'));
      const body = new FormData();
      body.append('message', message);
      const response = await fetch(`/api/chat?id=${encodeURIComponent(session.id)}`, {
        method: 'POST',
        body,
      });
      if (!response.ok) {
        sessionStorage.setItem(`pi-personal:draft:${session.id}`, message);
      }
      navigate(`/session?id=${encodeURIComponent(session.id)}`);
    } catch (error) {
      homeError = error.message || t('index.networkError');
    } finally {
      creating = false;
    }
  }

  const totalSessionsLabel = $derived(
    total === 1 ? t('index.sessionCountOne') : t('index.sessionsCount', { count: total }),
  );
  const hasMore = $derived(sessions.length < total);
  const runningCount = $derived(runningSessionIds.size);

  function setRunningSessions(snapshot) {
    const ids = Array.isArray(snapshot) ? snapshot : snapshot?.ids;
    const statuses = snapshot && !Array.isArray(snapshot) ? snapshot.statuses : {};
    runningSessionIds.clear();
    for (const id of Array.isArray(ids) ? ids : []) runningSessionIds.add(id);
    runningStatuses.clear();
    for (const [key, value] of Object.entries(statuses || {})) runningStatuses.set(key, value);
  }

  function setSessionRunning(id, running, status = {}) {
    if (running) {
      runningSessionIds.add(id);
      runningStatuses.set(id, status);
    } else {
      runningSessionIds.delete(id);
      runningStatuses.delete(id);
    }
  }

  async function refreshSessions({ preserveWindow = false } = {}) {
    if (refreshInflight || newSessionOpen) return;
    refreshInflight = true;
    try {
      const limit = preserveWindow ? Math.max(PAGE_SIZE, sessions.length) : PAGE_SIZE;
      const response = await defaultFetchSessions({ limit });
      sessions = (response.sessions || []).map(normalizeSession);
      total = response.total ?? sessions.length;
      await tick();
      refreshSessionPalette();
    } catch {
      // Keep existing list if a soft refresh fails.
    } finally {
      refreshInflight = false;
      loading = false;
      layoutReady = true;
    }
  }

  async function loadMore() {
    if (loadingMore || refreshInflight) return;
    loadingMore = true;
    try {
      const response = await defaultFetchSessions({ limit: PAGE_SIZE, offset: sessions.length });
      const more = (response.sessions || []).map(normalizeSession);
      const seen = new Set(sessions.map((session) => session.id));
      sessions = [...sessions, ...more.filter((session) => !seen.has(session.id))];
      total = response.total ?? total;
    } catch {
      // Leave the loaded list untouched if a page fails to load.
    } finally {
      loadingMore = false;
    }
  }

  const RELOAD_DEBOUNCE_MS = 500;
  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (newSessionOpen) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      refreshSessions({ preserveWindow: true });
    }, RELOAD_DEBOUNCE_MS);
  }

  function setLayout(nextLayout) {
    layout = nextLayout === 'projects' ? 'projects' : 'timeline';
    writeSetting(layoutStorageKey, layout, { storage: localStorage });
  }

  async function openNewSessionModal() {
    closeMenu();
    projectsOpen = false;
    newSessionOpen = true;
    newSessionPath = '';
    newSessionError = '';
    document.body?.classList.add('modal-sheet-open');
    try {
      const response = await defaultFetchRecent();
      recentLocations = (response.locations || []).slice(0, 10);
      const connections = await getJSON('/api/connections');
      newSessionPath = recentLocations[0] || connections.defaultWorkspace || '';
    } catch {
      recentLocations = [];
    }
    await tick();
    document.getElementById('sessionPath')?.focus();
  }

  function closeNewSessionModal() {
    newSessionOpen = false;
    document.body?.classList.remove('modal-sheet-open');
  }

  async function createSession() {
    const path = newSessionPath.trim();
    if (!path) {
      newSessionError = t('index.enterPath');
      return;
    }
    creating = true;
    newSessionError = '';
    try {
      const response = await defaultCreateSession(path);
      if (response.ok && response.id) {
        navigate('/session?id=' + encodeURIComponent(response.id));
        return;
      }
      newSessionError = response.error || t('index.failedCreateSession');
    } catch (error) {
      newSessionError = error.message || t('index.networkError');
    } finally {
      creating = false;
    }
  }

  function closeMenu() {
    menuOpen = false;
  }
  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  async function refreshProjectsList() {
    projectsError = '';
    projectsBusy = true;
    try {
      const response = await defaultFetchProjects();
      projects = Array.isArray(response.projects) ? response.projects : [];
      projectsFilterEnabled = !!response.filterEnabled;
    } catch (error) {
      projectsError = error.message || t('index.failedLoadProjects');
    } finally {
      projectsBusy = false;
    }
  }

  async function openProjectsModal() {
    closeMenu();
    newSessionOpen = false;
    projectsOpen = true;
    document.body?.classList.add('modal-sheet-open');
    await refreshProjectsList();
  }

  function closeProjectsModal() {
    projectsOpen = false;
    document.body?.classList.remove('modal-sheet-open');
  }

  async function updateProject(path, action) {
    projectsBusy = true;
    projectsError = '';
    try {
      await defaultUpdateProject(path, action);
      await refreshSessions();
      await refreshProjectsList();
    } catch (error) {
      projectsError = error.message || t('index.failedUpdateProject');
    } finally {
      projectsBusy = false;
    }
  }

  function openPalette() {
    openSessionPalette();
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = 'Pi Sessions';
    configureSettingsSync({ fetchImpl: window.fetch.bind(window) });
    setupKeyboardNav({ windowImpl: window, documentImpl: document });

    try {
      layout = localStorage.getItem(layoutStorageKey) === 'projects' ? 'projects' : 'timeline';
    } catch {}
    hydrateSettings({ storage: localStorage })
      .then((settings) => {
        if (!settings) return;
        const serverLayout = settings[layoutStorageKey] === 'projects' ? 'projects' : 'timeline';
        if (serverLayout !== layout) setLayout(serverLayout);
      })
      .catch(() => {});

    const statusEvents = createStatusEvents({
      onSnapshot: (snapshot) => setRunningSessions(snapshot),
      onDelta: (status) => setSessionRunning(status.id, status.running, status),
      onMessage: (message) => {
        if (message === 'new-session') refreshSessions({ preserveWindow: true });
        if (message === 'reload') scheduleReload();
      },
    });
    try {
      statusEvents.connect();
    } catch {}
    const settingsEvents = createAppEvents({
      event: 'settings',
      onEvent: (payload) => {
        applyRemoteSettings(payload, {
          storage: localStorage,
          documentImpl: document,
          windowImpl: window,
        });
      },
    });
    try {
      settingsEvents.connect();
    } catch {}

    const keydown = (e) => {
      if (matchesAction('toggle-theme', e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleTheme(window, document);
        syncThemeIcons(document);
        return;
      }
      if (matchesAction('open-palette', e)) {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === 'Escape') {
        if (menuOpen) closeMenu();
        else if (projectsOpen) closeProjectsModal();
        else if (newSessionOpen) closeNewSessionModal();
      }
    };
    window.addEventListener('keydown', keydown, { capture: true });
    const click = () => closeMenu();
    window.addEventListener('click', click);

    refreshSessions();
    const hubUpdated = () => refreshSessions({ preserveWindow: true });
    window.addEventListener('pi:hub-updated', hubUpdated);

    return () => {
      window.removeEventListener('pi:hub-updated', hubUpdated);
      document.title = previousTitle;
      document.body?.classList.remove('modal-sheet-open');
      window.removeEventListener('keydown', keydown, { capture: true });
      window.removeEventListener('click', click);
      statusEvents.cleanup?.();
      settingsEvents.cleanup?.();
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<div class="personal-home">
  <aside class="personal-home-nav" aria-label={t('home.navigation')}>
    <a class="personal-brand" href="/">Pi<span>Workspace</span></a>
    <button class="personal-nav-new" onclick={openNewSessionModal}
      >{@html icon(Plus, { size: 18 })}{t('index.startNewSession')}</button
    >
    <button onclick={openPalette}
      >{@html icon(Search, { size: 17 })}{t('index.searchSessions')}</button
    >
    <button onclick={openProjectsModal}
      >{@html icon(FolderGit2, { size: 17 })}{t('index.manageProjects')}</button
    >
    <div class="personal-nav-spacer"></div>
    <button onclick={() => window.dispatchEvent(new CustomEvent('pi:devices'))}
      >{@html icon(Link2, { size: 17 })}{t('devices.title')}</button
    >
    <button onclick={() => openHub('connections')}
      >{@html icon(Link2, { size: 17 })}{t('hub.connections')}</button
    >
    <button onclick={() => openHub('trash')}
      >{@html icon(Trash2, { size: 17 })}{t('hub.trash')}</button
    >
    <button onclick={() => navigate('/settings')}
      >{@html icon(Settings, { size: 17 })}{t('common.settings')}</button
    >
    <div class="personal-nav-caption">{t('home.privateWorkspace')}</div>
  </aside>
  <main class="personal-home-main">
    <section class="personal-welcome">
      <div class="personal-eyebrow">Pi Workspace</div>
      <h1>{t('home.headline')}</h1>
      <form
        class="personal-start-box"
        onsubmit={(event) => {
          event.preventDefault();
          startPrompt();
        }}
      >
        <textarea
          aria-label={t('composer.placeholder')}
          placeholder={t('composer.placeholder')}
          bind:value={homePrompt}
          rows="2"
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              startPrompt();
            }
          }}
        ></textarea>
        <div class="personal-start-footer">
          <span>{t('home.localFirst')}</span><button
            type="submit"
            disabled={creating || !homePrompt.trim()}
            aria-label={t('composer.send')}
            >{@html icon(creating ? Plus : Send, { size: 18 })}</button
          >
        </div>
      </form>
      {#if homeError}<p class="output-error">{homeError}</p>{/if}
    </section>

    <IndexHeader
      {layout}
      {totalSessionsLabel}
      {runningCount}
      runningVisible={runningCount > 0}
      onSearch={openPalette}
      onToggleMenu={toggleMenu}
      onLayoutChange={setLayout}
      onSchedules={() => navigate('/schedules', { state: backState() })}
    />

    <HomeMenu
      open={menuOpen}
      onClose={closeMenu}
      onNewSession={openNewSessionModal}
      onManageProjects={openProjectsModal}
    />

    <button
      class="new-session-btn new-session-btn-mobile"
      id="newSessionBtn"
      type="button"
      data-new-session-btn
      aria-label={t('index.startNewSession')}
      title={t('index.newSession')}
      onclick={openNewSessionModal}>+</button
    >

    <CommandPalette
      onNewSession={openNewSessionModal}
      {runningSessionIds}
      navigate={(url) => navigate(url)}
    />

    <SessionsList
      {sessions}
      {layout}
      {runningSessionIds}
      {runningStatuses}
      {loading}
      {layoutReady}
      {hasMore}
      {loadingMore}
      onLoadMore={loadMore}
    />

    <NewSessionModal
      open={newSessionOpen}
      recent={recentLocations}
      bind:path={newSessionPath}
      {creating}
      error={newSessionError}
      onClose={closeNewSessionModal}
      onCreate={createSession}
    />

    <ProjectsModal
      open={projectsOpen}
      {projects}
      filterEnabled={projectsFilterEnabled}
      error={projectsError}
      busy={projectsBusy}
      onClose={closeProjectsModal}
      onToggleProject={(path, enabled) => updateProject(path, enabled ? 'enable' : 'disable')}
      onToggleAll={(enabled) => updateProject('', enabled ? 'enable-all' : 'disable-all')}
      onToggleFilter={(enabled) => updateProject('', enabled ? 'enable-filter' : 'disable-filter')}
      onRegister={(path) => updateProject(path, 'register')}
      onRemove={(path) => updateProject(path, 'remove')}
    />
  </main>
</div>

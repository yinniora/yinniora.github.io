<script>
  import MobileHome from '../components/index/MobileHome.svelte';
  import ConnectionStatus from '../components/shared/ConnectionStatus.svelte';
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
  import { navigate, backState, handleNavClick } from '../shared/navigation.js';
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
  let mobile = $state(window.matchMedia?.('(max-width: 900px)').matches || false);
  let defaultWorkspace = $state('');
  let homeRevision = $state(0);
  let projectsAddOnly = $state(false);
  let projectToDelete = $state(null);
  let homePrompt = $state('');
  let homeError = $state('');
  let active = false;

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
      if (!active) return;
      const body = new FormData();
      body.append('message', message);
      const response = await fetch(`/api/chat?id=${encodeURIComponent(session.id)}`, {
        method: 'POST',
        body,
      });
      if (!response.ok) {
        sessionStorage.setItem(`pi-personal:draft:${session.id}`, message);
      }
      if (active) navigate(`/session?id=${encodeURIComponent(session.id)}`);
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
      if (mobile) homeRevision += 1;
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
    if (!mobile) document.getElementById('sessionPath')?.focus({ preventScroll: true });
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
        if (active && newSessionOpen) navigate('/session?id=' + encodeURIComponent(response.id));
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

  async function openProjectsModal({ addOnly = false, project = null } = {}) {
    projectsAddOnly = addOnly;
    projectToDelete = project;
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

  async function updateProject(path, action, options = {}) {
    projectsBusy = true;
    projectsError = '';
    try {
      await defaultUpdateProject(path, action, options);
      await refreshSessions();
      await refreshProjectsList();
      if (action === 'delete') {
        window.dispatchEvent(new CustomEvent('pi:hub-updated'));
      }
      homeRevision += 1;
      if (action === 'delete' || (action === 'register' && projectsAddOnly)) closeProjectsModal();
      return true;
    } catch (error) {
      projectsError =
        action === 'delete'
          ? t('projects.deleteFailed')
          : error.message || t('index.failedUpdateProject');
      return false;
    } finally {
      projectsBusy = false;
    }
  }

  async function createProjectSession(path = defaultWorkspace, ordinary = false) {
    if (!path && !ordinary) {
      await openNewSessionModal();
      return;
    }
    if (creating) return;
    creating = true;
    homeError = '';
    try {
      const response = await defaultCreateSession(path, ordinary ? { ordinary: true } : {});
      if (!response.id) throw new Error(response.error || t('index.failedCreateSession'));
      if (active) navigate('/session?id=' + encodeURIComponent(response.id));
    } catch (error) {
      homeError = error.message || t('index.networkError');
    } finally {
      creating = false;
    }
  }

  async function refreshHome() {
    await Promise.all([refreshSessions({ preserveWindow: true }), refreshProjectsList()]);
    homeRevision += 1;
  }

  function openPalette() {
    openSessionPalette();
  }

  onMount(() => {
    active = true;
    const media = window.matchMedia?.('(max-width: 900px)');
    const resize = () => {
      mobile = !!media?.matches;
    };
    media?.addEventListener('change', resize);
    getJSON('/api/connections')
      .then((data) => {
        defaultWorkspace = data.defaultWorkspace || '';
      })
      .catch(() => {});
    const previousTitle = document.title;
    document.title = t('app.name');
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
      onDelta: (status) => {
        setSessionRunning(status.id, status.running, status);
        if (!status.running) scheduleReload();
      },
      onMessage: (message) => {
        if (message === 'new-session') refreshHome();
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

    refreshHome();
    const hubUpdated = () => refreshHome();
    window.addEventListener('pi:hub-updated', hubUpdated);

    return () => {
      active = false;
      media?.removeEventListener('change', resize);
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
    <a class="personal-brand" href="/" onclick={(event) => handleNavClick(event, '/')}
      >{t('app.name')}<span>Workspace</span></a
    >
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
    <button onclick={() => navigate('/settings', { state: backState() })}
      >{@html icon(Settings, { size: 17 })}{t('common.settings')}</button
    >
    <div class="personal-nav-caption">{t('home.privateWorkspace')}</div>
  </aside>
  <main class="personal-home-main">
    {#if mobile}
      <MobileHome
        {projects}
        {defaultWorkspace}
        revision={homeRevision}
        loading={loading || projectsBusy}
        error={homeError || projectsError}
        {creating}
        {menuOpen}
        {runningSessionIds}
        {runningStatuses}
        onNewProject={() => openProjectsModal({ addOnly: true })}
        onNewSession={() => createProjectSession(defaultWorkspace, true)}
        onProjectSession={createProjectSession}
        onDeleteProject={(project) => openProjectsModal({ project })}
        onSearch={openPalette}
        onMenu={toggleMenu}
        onRetry={refreshHome}
      />
    {:else}
      <section class="personal-welcome">
        <div class="personal-eyebrow">{t('app.name')} <ConnectionStatus /></div>
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
    {/if}

    <HomeMenu
      open={menuOpen}
      onClose={closeMenu}
      onNewSession={openNewSessionModal}
      onManageProjects={openProjectsModal}
    />

    <CommandPalette
      onNewSession={openNewSessionModal}
      {runningSessionIds}
      navigate={(url) => navigate(url)}
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
      addOnly={projectsAddOnly}
      initialProject={projectToDelete}
      {projects}
      filterEnabled={projectsFilterEnabled}
      error={projectsError}
      busy={projectsBusy}
      onClose={closeProjectsModal}
      onToggleProject={(path, enabled) => updateProject(path, enabled ? 'enable' : 'disable')}
      onToggleAll={(enabled) => updateProject('', enabled ? 'enable-all' : 'disable-all')}
      onToggleFilter={(enabled) => updateProject('', enabled ? 'enable-filter' : 'disable-filter')}
      onRegister={(path) => updateProject(path, 'register')}
      onDelete={(path, options) => updateProject(path, 'delete', options)}
    />
  </main>
</div>

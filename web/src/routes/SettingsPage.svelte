<script>
  import RemoteSettings from '../components/settings/RemoteSettings.svelte';
  import ModelSettings from '../components/settings/ModelSettings.svelte';
  import PluginSettings from '../components/settings/PluginSettings.svelte';
  import ConnectionStatus from '../components/shared/ConnectionStatus.svelte';
  import { onMount } from 'svelte';
  import AboutSettings from '../components/settings/AboutSettings.svelte';
  import AppearanceSettings from '../components/settings/AppearanceSettings.svelte';
  import ArtifactSettings from '../components/settings/ArtifactSettings.svelte';
  import CatGatekeeperSettings from '../components/settings/CatGatekeeperSettings.svelte';
  import LanguageSettings from '../components/settings/LanguageSettings.svelte';
  import NotificationSettings from '../components/settings/NotificationSettings.svelte';
  import SessionDisplayDefaultsSettings from '../components/settings/SessionDisplayDefaultsSettings.svelte';
  import SessionsListSettings from '../components/settings/SessionsListSettings.svelte';
  import SessionTitleSettings from '../components/settings/SessionTitleSettings.svelte';
  import { t } from '../shared/i18n.js';
  import { navigate, replaceLocation } from '../shared/navigation.js';
  import { setupSwipeBack } from '../shared/swipe-back.js';
  import { loadSettings, persistSetting } from '../settings/settings-support.js';
  import { createAppEvents } from '../shared/app-events.js';
  import { applyRemoteSettings } from '../shared/settings-live.js';

  let settings = $state({});
  let savedVisible = $state(false);
  let savedTimer = null;

  const sections = [
    { id: 'appearance', labelKey: 'settings.appearance' },
    { id: 'language', labelKey: 'settings.language' },
    { id: 'models', labelKey: 'models.title' },
    { id: 'plugins', labelKey: 'plugins.title' },
    { id: 'sessionsList', labelKey: 'settings.sessionsList' },
    { id: 'sessionTitles', labelKey: 'settings.sessionTitles' },
    { id: 'sessionDisplay', labelKey: 'settings.sessionDisplay' },
    { id: 'artifacts', labelKey: 'settings.artifacts' },
    { id: 'notifications', labelKey: 'settings.notifications' },
    { id: 'catGatekeeper', labelKey: 'settings.catGatekeeper' },
    { id: 'remote', labelKey: 'remoteSettings.title' },
    { id: 'about', labelKey: 'settings.about' },
  ];
  const sectionIds = new Set(sections.map((s) => s.id));

  let activeSection = $state('appearance');
  let isMobile = $state(false);
  let mobileShowingPane = $state(false);
  let cameFromApp = $state(false);
  let settingsPage = $state(null);

  const activeLabel = $derived(
    t(sections.find((s) => s.id === activeSection)?.labelKey || 'settings.title'),
  );

  function sectionFromUrl(win) {
    try {
      const id = new URLSearchParams(win.location.search).get('section');
      return id && sectionIds.has(id) ? id : null;
    } catch {
      return null;
    }
  }

  function syncSectionUrl(win, id) {
    try {
      replaceLocation(id ? `${win.location.pathname}?section=${id}` : win.location.pathname, {
        windowImpl: win,
      });
    } catch {}
  }

  function selectSection(id) {
    activeSection = id;
    if (isMobile) mobileShowingPane = true;
    syncSectionUrl(window, id);
  }

  function backToList() {
    mobileShowingPane = false;
    syncSectionUrl(window, '');
    const root = settingsPage?.closest('#spa-root');
    if (root) root.scrollTop = 0;
  }

  function leaveSettings() {
    navigate(typeof window.history.state?.back === 'string' ? window.history.state.back : '/');
  }

  function onHomeBack(e) {
    if (e.defaultPrevented) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    leaveSettings();
  }

  function flashSaved() {
    savedVisible = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedVisible = false;
    }, 1200);
  }

  function saveSetting(key, value) {
    settings = { ...settings, [key]: value };
    persistSetting(key, value, { storage: localStorage });
    flashSaved();
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = `${t('settings.title')} — ${t('app.name')}`;

    cameFromApp = typeof window.history.state?.back === 'string';

    const mq = window.matchMedia?.('(max-width: 760px)');
    const updateMobile = () => {
      isMobile = !!mq?.matches;
      if (!isMobile) mobileShowingPane = false;
    };
    updateMobile();
    mq?.addEventListener('change', updateMobile);
    const stopSwipe = setupSwipeBack(settingsPage, {
      enabled: () => isMobile,
      startOnControl: '[data-settings-nav]',
      onBack: () => (mobileShowingPane ? backToList() : leaveSettings()),
    });

    const initialSection = sectionFromUrl(window);
    if (initialSection) {
      activeSection = initialSection;
      if (isMobile) mobileShowingPane = true;
    }

    loadSettings({ windowImpl: window })
      .then((loaded) => {
        settings = loaded || {};
      })
      .catch(() => {});
    const settingsEvents = createAppEvents({
      event: 'settings',
      onEvent: (payload) => {
        const next = applyRemoteSettings(payload, {
          storage: localStorage,
          documentImpl: document,
          windowImpl: window,
        });
        if (next) settings = { ...settings, ...next };
      },
    });
    try {
      settingsEvents.connect();
    } catch {}
    return () => {
      document.title = previousTitle;
      clearTimeout(savedTimer);
      mq?.removeEventListener('change', updateMobile);
      stopSwipe();
      settingsEvents.cleanup?.();
    };
  });
</script>

<div class="session-header-bar">
  <div class="session-header-left">
    {#if isMobile && mobileShowingPane}
      <button type="button" class="session-header-back" onclick={backToList}>
        <span>←</span>
        {t('settings.title')}
      </button>
    {:else}
      <a class="session-header-back" href="/" onclick={onHomeBack}>
        <span>←</span>
        {cameFromApp ? t('common.back') : t('session.back')}
      </a>
    {/if}
  </div>
  <span class="session-header-title">
    {isMobile && mobileShowingPane ? activeLabel : t('settings.title')}
  </span>
  <div class="session-header-right"><ConnectionStatus /></div>
</div>

<div
  class="settings-page"
  bind:this={settingsPage}
  class:settings-page-mobile-list={isMobile && !mobileShowingPane}
  class:settings-page-mobile-pane={isMobile && mobileShowingPane}
>
  <nav class="settings-sidebar" aria-label={t('settings.title')}>
    {#each sections as section (section.id)}
      <button
        type="button"
        class="settings-sidebar-item"
        class:active={activeSection === section.id}
        data-settings-nav={section.id}
        aria-current={activeSection === section.id ? 'page' : undefined}
        onclick={() => selectSection(section.id)}
      >
        <span>{t(section.labelKey)}</span>
        <span class="settings-sidebar-chev" aria-hidden="true">›</span>
      </button>
    {/each}
  </nav>

  <div class="settings-pane">
    {#if activeSection === 'appearance'}
      <AppearanceSettings {settings} onSave={saveSetting} onSaved={flashSaved} />
    {:else if activeSection === 'language'}
      <LanguageSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'models'}
      <ModelSettings />
    {:else if activeSection === 'plugins'}
      <PluginSettings />
    {:else if activeSection === 'sessionsList'}
      <SessionsListSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'sessionTitles'}
      <SessionTitleSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'sessionDisplay'}
      <SessionDisplayDefaultsSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'artifacts'}
      <ArtifactSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'notifications'}
      <NotificationSettings {settings} onSave={saveSetting} onSaved={flashSaved} />
    {:else if activeSection === 'catGatekeeper'}
      <CatGatekeeperSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'remote'}
      <RemoteSettings />
    {:else if activeSection === 'about'}
      <AboutSettings />
    {/if}
  </div>

  <div class="settings-saved-hint" class:visible={savedVisible} data-settings-saved>
    {t('common.saved')}
  </div>
</div>

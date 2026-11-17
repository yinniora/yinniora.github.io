<script>
  import ConnectionStatus from '../shared/ConnectionStatus.svelte';
  import HomeProject from './HomeProject.svelte';
  import { t } from '../../shared/i18n.js';
  import { icon, Plus, FolderPlus, Search, Ellipsis } from '../../shared/icons.js';
  let {
    projects = [],
    defaultWorkspace = '',
    revision = 0,
    loading = false,
    error = '',
    creating = false,
    menuOpen = false,
    runningSessionIds = new Set(),
    runningStatuses = new Map(),
    onNewProject = () => {},
    onNewSession = () => {},
    onProjectSession = () => {},
    onDeleteProject = () => {},
    onSearch = () => {},
    onMenu = () => {},
    onRetry = () => {},
  } = $props();
  const folders = $derived(projects.filter((project) => project.path !== defaultWorkspace));
  const ordinary = $derived(projects.find((project) => project.path === defaultWorkspace));
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<div class="mobile-home">
  <header class="mobile-home-header">
    <div class="mobile-home-brand">{t('app.name')} <ConnectionStatus /></div>
    <div class="mobile-home-tools">
      <button class="home-icon-button" aria-label={t('index.searchSessions')} onclick={onSearch}
        >{@html icon(Search, { size: 20 })}</button
      >
      <button
        class="home-icon-button"
        id="web-menu-btn"
        aria-haspopup="menu"
        aria-controls="web-menu"
        aria-expanded={menuOpen}
        aria-label={t('mobile.menu')}
        onclick={(event) => {
          event.stopPropagation();
          onMenu();
        }}>{@html icon(Ellipsis, { size: 22 })}</button
      >
    </div>
  </header>
  <main class="mobile-home-content">
    <div class="mobile-home-heading">
      <h1>{t('mobile.workspace')}</h1>
      <p>{t('mobile.workspaceHint')}</p>
    </div>
    <div class="mobile-home-create">
      <button disabled={creating} onclick={onNewProject}
        >{@html icon(FolderPlus, { size: 19 })}{t('mobile.newProject')}</button
      >
      <button disabled={creating} onclick={onNewSession}
        >{@html icon(Plus, { size: 19 })}{t('mobile.newOrdinarySession')}</button
      >
    </div>
    {#if error}<p class="home-inline-error" role="alert">
        {error}<button onclick={onRetry}>{t('common.retry')}</button>
      </p>{/if}
    {#if loading && !projects.length}<p class="home-list-hint" role="status">
        {t('index.loadingSessions')}
      </p>{/if}
    {#if folders.length}<h2 class="mobile-home-section-title">
        {t('mobile.projects')}<span>{folders.length}</span>
      </h2>{/if}
    {#each folders as project (project.path)}
      <HomeProject
        {project}
        {revision}
        {runningSessionIds}
        {runningStatuses}
        onNewSession={onProjectSession}
        {onDeleteProject}
      />
    {/each}
    {#if ordinary}<HomeProject
        project={ordinary}
        ordinary
        {revision}
        {runningSessionIds}
        {runningStatuses}
        onNewSession={onProjectSession}
      />{/if}
    {#if !loading && !error && !projects.length}<p class="home-list-hint">
        {t('mobile.emptyWorkspace')}
      </p>{/if}
  </main>
</div>

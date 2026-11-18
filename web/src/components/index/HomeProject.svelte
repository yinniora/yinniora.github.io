<script>
  import { onMount, untrack } from 'svelte';
  import { icon, ChevronRight, FolderGit2, Plus, Ellipsis, Trash2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import {
    collapsedProjectsStorageKey,
    defaultFetchSessions,
    normalizeSession,
    sessionsCountLabel,
  } from '../../index/sessions.js';
  import SessionCard from './SessionCard.svelte';

  let {
    project,
    revision = 0,
    ordinary = false,
    runningSessionIds = new Set(),
    runningStatuses = new Map(),
    onNewSession = () => {},
    onDeleteProject = () => {},
  } = $props();
  let expanded = $state(false);
  let ready = $state(false);
  let entries = $state([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state('');
  let menu = $state(null);
  let generation = 0;
  const name = $derived(
    ordinary ? t('mobile.ordinarySessions') : project.path.split('/').filter(Boolean).at(-1),
  );

  async function load(append = false, limit = 20) {
    const request = ++generation;
    loading = true;
    error = '';
    try {
      const data = await defaultFetchSessions({
        project: project.path,
        limit,
        offset: append ? entries.length : 0,
      });
      if (request !== generation) return;
      const next = (data.sessions || []).map(normalizeSession);
      const seen = new Set(append ? entries.map((entry) => entry.id) : []);
      entries = [...(append ? entries : []), ...next.filter((entry) => !seen.has(entry.id))];
      total = data.total ?? entries.length;
    } catch {
      if (request === generation) error = t('mobile.loadSessionsFailed');
    } finally {
      if (request === generation) loading = false;
    }
  }

  function toggle() {
    expanded = !expanded;
    try {
      const collapsed = JSON.parse(localStorage.getItem(collapsedProjectsStorageKey) || '{}');
      collapsed[project.path] = expanded ? 0 : 1;
      localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify(collapsed));
    } catch {
      /* The current expansion still works without storage. */
    }
  }

  $effect(() => {
    revision;
    if (ready && expanded) untrack(() => load(false, Math.max(20, entries.length)));
  });

  onMount(() => {
    const closeMenu = (event) => {
      if (menu?.open && !menu.contains(event.target)) menu.open = false;
    };
    window.addEventListener('click', closeMenu);
    try {
      expanded = !JSON.parse(localStorage.getItem(collapsedProjectsStorageKey) || '{}')[
        project.path
      ];
    } catch {
      expanded = true;
    }
    ready = true;
    return () => {
      generation += 1;
      window.removeEventListener('click', closeMenu);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<section class="home-project" data-home-project={project.path}>
  <div class="home-project-header">
    <button class="home-project-toggle" aria-expanded={expanded} onclick={toggle}>
      <span class="home-project-chevron" class:expanded
        >{@html icon(ChevronRight, { size: 16 })}</span
      >
      {#if !ordinary}<span class="home-folder-icon">{@html icon(FolderGit2, { size: 18 })}</span
        >{/if}
      <span class="home-project-name"
        >{name}<small>{sessionsCountLabel(project.sessionCount || 0)}</small></span
      >
    </button>
    <button
      class="home-icon-button"
      aria-label={t('mobile.newSessionIn', { name })}
      onclick={() => onNewSession(project.path)}>{@html icon(Plus, { size: 20 })}</button
    >
    {#if !ordinary}
      <details class="home-project-menu" bind:this={menu}>
        <summary aria-label={t('mobile.manageProject', { name })}
          >{@html icon(Ellipsis, { size: 20 })}</summary
        >
        <div class="home-project-popover">
          <button
            onclick={() => {
              menu.open = false;
              onNewSession(project.path);
            }}>{@html icon(Plus, { size: 16 })}{t('index.newSession')}</button
          >
          <button
            class="home-danger"
            onclick={() => {
              menu.open = false;
              onDeleteProject(project);
            }}>{@html icon(Trash2, { size: 16 })}{t('projects.delete')}</button
          >
        </div>
      </details>
    {/if}
  </div>
  {#if expanded}
    <div class="home-project-sessions">
      {#each entries as session (session.id)}
        <SessionCard
          {session}
          running={runningSessionIds.has(session.id)}
          runningStatus={runningStatuses.get(session.id)}
        />
      {/each}
      {#if error}<p class="home-inline-error" role="alert">
          {error}<button onclick={() => load()}>{t('common.retry')}</button>
        </p>
      {:else if loading}<p class="home-list-hint" role="status">{t('index.loadingSessions')}</p>
      {:else if !entries.length}<button
          class="home-empty-project"
          onclick={() => onNewSession(project.path)}
          >{@html icon(Plus, { size: 16 })}{t('mobile.firstSession')}</button
        >{/if}
      {#if entries.length < total && !error}<button
          class="home-load-more"
          disabled={loading}
          onclick={() => load(true)}>{t('index.loadMore')}</button
        >{/if}
    </div>
  {/if}
</section>

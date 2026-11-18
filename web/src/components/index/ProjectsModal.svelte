<script>
  import MacFolderPicker from '../shared/MacFolderPicker.svelte';
  import { icon, Trash2, FolderGit2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { sessionsCountLabel } from '../../index/sessions.js';

  let {
    open = false,
    addOnly = false,
    initialProject = null,
    projects = [],
    filterEnabled = false,
    error = '',
    busy = false,
    onClose = () => {},
    onToggleProject = async () => {},
    onToggleAll = async () => {},
    onToggleFilter = async () => {},
    onRegister = async () => {},
    onDelete = async () => false,
  } = $props();

  let query = $state('');
  let addPath = $state('');
  let deleting = $state(null);
  let deleteFiles = $state(false);
  let confirmFiles = $state(false);
  const basename = (path) =>
    String(path).replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || '';
  $effect(() => {
    if (open && initialProject) {
      deleting = initialProject;
      deleteFiles = false;
      confirmFiles = false;
    } else if (!open) {
      deleting = null;
      deleteFiles = false;
      confirmFiles = false;
    }
  });
  function askDelete(project) {
    deleting = project;
    deleteFiles = false;
    confirmFiles = false;
  }
  async function deleteProject() {
    if (!deleting || busy) return;
    if (deleteFiles && !confirmFiles) {
      confirmFiles = true;
      return;
    }
    const ok = await onDelete(deleting.path, {
      deleteFiles,
      confirmation: deleteFiles ? basename(deleting.path) : '',
    });
    if (ok) deleting = null;
  }

  const visibleProjects = $derived(
    projects.filter(
      (project) =>
        !query.trim() ||
        String(project.path || '')
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ),
  );
  const allEnabled = $derived(projects.length > 0 && projects.every((p) => p.enabled));

  async function registerProject() {
    const path = addPath.trim();
    if (!path) return;
    await onRegister(path);
    addPath = '';
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<div
  class="modal-overlay"
  id="projectsModalOverlay"
  class:visible={open}
  class:open
  inert={!open}
  role="presentation"
  onclick={(e) => {
    if (e.currentTarget === e.target) onClose();
  }}
>
  <div class="modal">
    <div class="modal-sheet-header">
      <button
        class="modal-sheet-back"
        id="projectsModalBackBtn"
        type="button"
        aria-label={t('index.closeManageProjects')}
        onclick={onClose}
      >
        <span aria-hidden="true">←</span>
        <span>{t(addOnly ? 'mobile.newProject' : 'index.manageProjectsTitle')}</span>
      </button>
    </div>
    <h2>{t(addOnly ? 'mobile.newProject' : 'index.manageProjectsTitle')}</h2>
    {#if deleting}
      <section class="project-delete-confirm" aria-label={t('projects.confirmTitle')}>
        <h3>{t(confirmFiles ? 'projects.confirmFilesTitle' : 'projects.confirmTitle')}</h3>
        <strong>{basename(deleting.path)}</strong>
        <code class="project-delete-path">{deleting.path}</code>
        <p>
          {t('projects.sessionsToTrash', {
            count: deleteFiles
              ? (deleting.fileSessionCount ?? deleting.sessionCount)
              : deleting.sessionCount,
          })}
        </p>
        <p class="project-delete-hint">{t('projects.pauseSchedules')}</p>
        {#if !confirmFiles}
          <label class="project-delete-files"
            ><input
              type="checkbox"
              bind:checked={deleteFiles}
              disabled={busy || !deleting.canDeleteFiles}
            />{t('projects.deleteFiles')}</label
          >
          <p class="project-delete-hint">
            {deleteFiles ? t('projects.filesToMacTrash') : t('projects.filesKept')}
          </p>
          {#if !deleting.canDeleteFiles}<p class="project-delete-hint">
              {t('projects.filesUnavailable')}
            </p>{/if}
        {:else}
          <p class="project-delete-final-warning">{t('projects.confirmFilesBody')}</p>
        {/if}
        {#if error}<p class="modal-error" role="alert">{error}</p>{/if}
        <div class="project-delete-actions">
          <button
            type="button"
            class="btn-secondary"
            disabled={busy}
            onclick={() => {
              if (confirmFiles) confirmFiles = false;
              else deleting = null;
            }}>{t('common.cancel')}</button
          >
          <button
            type="button"
            class="project-delete-submit danger-confirm"
            disabled={busy}
            onclick={deleteProject}
            >{busy
              ? t('projects.deleting')
              : t(confirmFiles ? 'projects.confirmFilesDelete' : 'projects.confirmDelete')}</button
          >
        </div>
      </section>
    {:else if !addOnly}
      <label class="projects-filter-switch">
        <span class="projects-filter-text">
          <span class="projects-filter-title">{t('index.filterProjects')}</span>
          <span class="projects-filter-desc" id="projectsFilterDesc"
            >{filterEnabled ? t('index.filterOnDesc') : t('index.filterOffDesc')}</span
          >
        </span>
        <span class="switch"
          ><input
            type="checkbox"
            id="projectsFilterToggle"
            checked={filterEnabled}
            disabled={busy}
            onchange={(e) => onToggleFilter(e.currentTarget.checked)}
          /><span class="switch-slider"></span></span
        >
      </label>
      <div class="projects-config" id="projectsConfig" class:filter-off={!filterEnabled}>
        <div class="projects-toolbar">
          <input
            type="search"
            id="projectsSearch"
            class="projects-search"
            placeholder={t('index.searchProjects')}
            autocomplete="off"
            bind:value={query}
          />
          <button
            class="projects-bulk-btn"
            id="projectsToggleAllBtn"
            type="button"
            disabled={busy || projects.length === 0}
            data-target={allEnabled ? 'disable' : 'enable'}
            onclick={() => onToggleAll(!allEnabled)}
            >{allEnabled ? t('index.deselectAll') : t('index.selectAll')}</button
          >
        </div>
        <div class="projects-list" id="projectsList" data-projects-list>
          {#if projects.length === 0}
            <div class="projects-empty">{t('index.noProjectsFound')}</div>
          {:else if visibleProjects.length === 0}
            <div class="projects-empty" data-projects-no-results>{t('index.noProjectsMatch')}</div>
          {:else}
            {#each visibleProjects as project (project.path)}
              <div class="project-row" data-path={project.path}>
                <input
                  type="checkbox"
                  checked={!!project.enabled}
                  disabled={busy}
                  onchange={(e) => onToggleProject(project.path, e.currentTarget.checked)}
                />
                <button
                  type="button"
                  class="project-row-name"
                  disabled={busy}
                  onclick={() => onToggleProject(project.path, !project.enabled)}
                  ><span class="project-folder-name"
                    >{@html icon(FolderGit2, { size: 16 })}<bdi>{basename(project.path)}</bdi></span
                  ><span class="project-folder-path">{project.path}</span></button
                >
                <span class="project-row-count"
                  >{sessionsCountLabel(project.sessionCount || 0)}</span
                >
                <button
                  type="button"
                  class="project-row-remove danger-button"
                  disabled={busy}
                  aria-label={`${t('projects.delete')} ${basename(project.path)}`}
                  onclick={() => askDelete(project)}
                >
                  {@html icon(Trash2, { size: 14 })}{t('projects.delete')}
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
    <div class="projects-footer" class:hidden={!!deleting}>
      <label class="projects-footer-label" for="projectsAddPath">{t('index.registerFolder')}</label>
      <input
        type="text"
        id="projectsAddPath"
        placeholder={t('index.sessionPathPlaceholder')}
        bind:value={addPath}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            registerProject();
          }
        }}
      />
      <MacFolderPicker value={addPath} disabled={busy} onSelect={(path) => (addPath = path)} />
      <div class="modal-error" id="projectsModalError">{error}</div>
      <div class="modal-actions">
        <button class="btn-secondary" id="projectsDoneBtn" type="button" onclick={onClose}
          >{t('common.done')}</button
        >
        <button
          class="btn-primary"
          id="projectsAddBtn"
          type="button"
          disabled={busy || !addPath.trim()}
          onclick={registerProject}>{t('common.add')}</button
        >
      </div>
    </div>
  </div>
</div>

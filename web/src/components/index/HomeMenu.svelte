<script>
  import { t } from '../../shared/i18n.js';
  import { openHub } from '../../shared/hub.js';
  import {
    icon,
    SquarePen,
    FolderGit2,
    BookOpen,
    Settings,
    Cpu,
    Trash2,
    ChevronRight,
    X,
    CalendarClock,
  } from '../../shared/icons.js';
  import { openVersionModal } from '../../shared/version.js';
  import { USER_DOCS_URL } from '../../shared/links.js';
  import { backState, handleNavClick } from '../../shared/navigation.js';
  let {
    open = false,
    onClose = () => {},
    onNewSession = () => {},
    onManageProjects = () => {},
  } = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div
  class="home-menu-backdrop"
  hidden={!open}
  inert={!open}
  role="presentation"
  onclick={onClose}
></div>
<div
  id="web-menu"
  class="home-menu"
  role="menu"
  tabindex="-1"
  aria-labelledby="web-menu-btn"
  hidden={!open}
  inert={!open}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => {
    if (e.key === 'Escape') onClose();
  }}
>
  <div class="home-menu-heading">
    <span
      ><strong>{t('app.name')}</strong><small>{t('index.title')} · {t('hub.connections')}</small
      ></span
    ><button class="home-menu-close" aria-label={t('common.close')} onclick={onClose}
      >{@html icon(X, { size: 18 })}</button
    >
  </div>
  <div class="home-menu-group">
    <a
      class="home-menu-row"
      role="menuitem"
      href="/schedules"
      data-schedules-menu
      onclick={(event) => {
        onClose();
        handleNavClick(event, '/schedules');
      }}
    >
      <span class="home-menu-icon">{@html icon(CalendarClock, { size: 18 })}</span><span
        >{t('schedules.navTitle')}</span
      >
      <span class="home-menu-chevron">{@html icon(ChevronRight, { size: 14 })}</span>
    </a>
    <button
      class="home-menu-row home-menu-new"
      role="menuitem"
      data-new-session-btn
      onclick={() => {
        onClose();
        onNewSession();
      }}
      ><span class="home-menu-icon">{@html icon(SquarePen, { size: 18 })}</span><span
        >{t('index.newSession')}</span
      ></button
    >
    <button
      class="home-menu-row"
      role="menuitem"
      id="manage-projects-btn"
      data-manage-projects-btn
      onclick={() => {
        onClose();
        onManageProjects();
      }}
      ><span class="home-menu-icon">{@html icon(FolderGit2, { size: 18 })}</span><span
        >{t('index.manageProjects')}</span
      ></button
    >
  </div>
  <div class="home-menu-group">
    <a
      class="home-menu-row"
      role="menuitem"
      href="/settings?section=models"
      data-models-menu
      onclick={(event) => {
        onClose();
        handleNavClick(event, '/settings?section=models', { state: backState() });
      }}
      ><span class="home-menu-icon">{@html icon(Cpu, { size: 18 })}</span><span
        >{t('models.title')}</span
      ><span class="home-menu-chevron">{@html icon(ChevronRight, { size: 14 })}</span></a
    >
    <button
      class="home-menu-row"
      role="menuitem"
      onclick={() => {
        onClose();
        openHub('trash');
      }}
      ><span class="home-menu-icon">{@html icon(Trash2, { size: 18 })}</span><span
        >{t('hub.trash')}</span
      ><span class="home-menu-chevron">{@html icon(ChevronRight, { size: 14 })}</span></button
    >
    <a
      class="home-menu-row"
      role="menuitem"
      href="/settings"
      onclick={(event) => {
        onClose();
        handleNavClick(event, '/settings', { state: backState() });
      }}
      ><span class="home-menu-icon">{@html icon(Settings, { size: 18 })}</span><span
        >{t('common.settings')}</span
      ><kbd>⌘,</kbd></a
    >
  </div>
  <div class="home-menu-footer">
    <a role="menuitem" href={USER_DOCS_URL} target="_blank" rel="noreferrer" onclick={onClose}
      >{@html icon(BookOpen, { size: 14 })}{t('common.userDocs')}</a
    ><button
      role="menuitem"
      onclick={() => {
        onClose();
        openVersionModal();
      }}>{t('common.version')}</button
    >
  </div>
</div>

<style>
  .home-menu {
    position: fixed;
    top: 58px;
    right: max(16px, calc((100vw - 1000px) / 2));
    z-index: 310;
    width: 280px;
    padding: 8px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 16px;
    box-shadow: 0 16px 60px #0006;
    font-family: var(--font-sans);
  }
  .home-menu[hidden] {
    display: none;
  }
  .home-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 300;
  }
  .home-menu-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 12px 15px;
  }
  .home-menu-heading strong {
    font-size: 17px;
    letter-spacing: -0.5px;
  }
  .home-menu-heading small {
    display: block;
    color: var(--muted);
    margin-top: 4px;
    font-size: 11px;
  }
  .home-menu-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--muted);
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  .home-menu-group {
    padding: 6px 0;
    border-top: 1px solid var(--dim);
  }
  .home-menu-row {
    display: flex;
    gap: 12px;
    align-items: center;
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    box-sizing: border-box;
    text-decoration: none;
    text-align: left;
    font: inherit;
    font-size: 13px;
    color: var(--text-soft);
    background: transparent;
    border: 0;
    border-radius: 9px;
    cursor: pointer;
  }
  .home-menu-row:hover,
  .home-menu-row:focus-visible {
    background: var(--surface-2);
    color: var(--text);
  }
  .home-menu-icon {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .home-menu-new,
  .home-menu-new .home-menu-icon {
    color: var(--accent);
  }
  .home-menu-chevron,
  kbd {
    margin-left: auto;
    color: var(--muted);
  }
  kbd {
    font-size: 11px;
  }
  .home-menu-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--dim);
    padding: 12px 10px 6px;
  }
  .home-menu-footer a,
  .home-menu-footer button {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    text-decoration: none;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  @media (max-width: 600px) {
    .home-menu {
      top: auto;
      right: 8px;
      left: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      width: auto;
      border-radius: 22px;
      padding: 10px 12px 16px;
    }
    .home-menu-backdrop {
      background: #0006;
      backdrop-filter: blur(3px);
    }
    .home-menu-row {
      min-height: 50px;
      font-size: 14px;
    }
    .home-menu-heading {
      padding: 10px 12px 16px;
    }
  }
</style>

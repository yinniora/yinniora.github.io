<script>
  import { flushSync, onDestroy } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { icon, Folder, FolderOpen, FolderPlus, ArrowUp, X } from '../../shared/icons.js';
  let {
    value = '',
    disabled = false,
    active = true,
    editing = $bindable(false),
    pathField,
    onSelect = () => {},
  } = $props();
  let open = $state(false),
    busy = $state(false),
    error = $state(''),
    listing = $state(null),
    query = $state(''),
    target = $state(null),
    creating = $state(false),
    name = $state(''),
    createError = $state('');
  let version = 0;
  let nameInput = $state(null);
  const nameField = $props.id();
  const folders = $derived(
    (listing?.folders || []).filter((item) =>
      item.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  async function browse(path = '') {
    const request = ++version;
    open = true;
    busy = true;
    error = '';
    query = '';
    cancelCreate();
    try {
      const data = await getJSON(
        '/api/project-folders' + (path ? '?path=' + encodeURIComponent(path) : ''),
      );
      if (request === version) listing = data;
    } catch {
      if (request === version) error = t('folders.unavailable');
    } finally {
      if (request === version) busy = false;
    }
  }
  function close() {
    version++;
    open = false;
    busy = false;
    listing = null;
    cancelCreate();
    creating = false;
  }
  function beginCreate(path, inBrowser, button) {
    if (!path.trim() || disabled || creating) return;
    flushSync(() => {
      target = { path: path.trim(), inBrowser, button };
      name = '';
      createError = '';
      editing = true;
    });
    nameInput?.focus({ preventScroll: true });
  }
  function cancelCreate(restoreFocus = false) {
    const button = target?.button;
    target = null;
    editing = false;
    if (restoreFocus) {
      flushSync();
      button?.focus({ preventScroll: true });
    }
  }
  async function createFolder(event) {
    event.preventDefault();
    if (!target || !name.trim() || creating || disabled) return;
    const request = ++version;
    creating = true;
    createError = '';
    try {
      const folder = await postJSON('/api/project-folders', {
        parent: target.path,
        name: name.trim(),
      });
      if (request !== version) return;
      onSelect(folder.path);
      if (open) {
        creating = false;
        await browse(folder.path);
      } else {
        cancelCreate(true);
      }
    } catch (failure) {
      if (request === version) {
        createError = t(
          failure.message === 'folder already exists'
            ? 'folders.exists'
            : failure.message === 'invalid folder name'
              ? 'folders.invalidName'
              : 'folders.createFailed',
        );
      }
    } finally {
      if (request === version) creating = false;
    }
  }
  $effect(() => {
    if (!active) close();
  });
  onDestroy(() => {
    version++;
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
{#snippet createForm()}
  <form class="mac-folder-create" onsubmit={createFolder}>
    <label for={nameField}>{t('folders.name')}</label>
    <input
      id={nameField}
      bind:this={nameInput}
      bind:value={name}
      maxlength="255"
      autocomplete="off"
      disabled={creating}
    />
    {#if createError}<p class="mac-folder-error" role="alert">{createError}</p>{/if}
    <div class="mac-folder-actions">
      <button type="button" disabled={creating} onclick={() => cancelCreate(true)}
        >{t('common.cancel')}</button
      >
      <button class="mac-folder-select" type="submit" disabled={creating || !name.trim()}
        >{t('common.create')}</button
      >
    </div>
  </form>
{/snippet}

{#if pathField}
  <div class="mac-folder-field">
    {@render pathField()}
    {#if value.trim()}
      <button
        class="mac-folder-new"
        type="button"
        disabled={disabled || editing}
        aria-expanded={!!target && !target.inBrowser}
        onclick={(event) => beginCreate(value, false, event.currentTarget)}
        >{@html icon(FolderPlus, { size: 16 })}{t('folders.new')}</button
      >
    {/if}
  </div>
{/if}
{#if target && !target.inBrowser}
  {@render createForm()}
{/if}
<div class="mac-folder-picker">
  <p class="mac-folder-hint">{t('folders.macHint')}</p>
  {#if !open}
    <button
      class="mac-folder-browse"
      type="button"
      disabled={disabled || editing}
      onclick={() => browse(value)}
      >{@html icon(FolderOpen, { size: 16 })}{t('folders.browse')}</button
    >
  {:else}
    <section class="mac-folder-browser" aria-label={t('folders.browse')}>
      <div class="mac-folder-toolbar">
        <button type="button" disabled={busy || editing} onclick={() => browse()}
          >{t('folders.home')}</button
        >
        <button
          type="button"
          disabled={busy || editing || !listing?.parent}
          onclick={() => browse(listing.parent)}
          >{@html icon(ArrowUp, { size: 14 })}{t('folders.parent')}</button
        >
        <button type="button" aria-label={t('common.close')} onclick={close}
          >{@html icon(X, { size: 15 })}</button
        >
      </div>
      {#if error}<p class="mac-folder-error" role="alert">{error}</p>{/if}
      {#if busy}<p role="status">{t('folders.loading')}</p>
      {:else if !error && listing}
        <div class="mac-folder-current">
          <code class="mac-folder-path">{listing.path}</code>
          <button
            class="mac-folder-new"
            type="button"
            disabled={disabled || editing}
            aria-expanded={!!target?.inBrowser}
            onclick={(event) => beginCreate(listing.path, true, event.currentTarget)}
            >{@html icon(FolderPlus, { size: 16 })}{t('folders.new')}</button
          >
        </div>
        {#if target?.inBrowser}
          {@render createForm()}
        {:else}
          <input
            type="search"
            aria-label={t('folders.search')}
            placeholder={t('folders.search')}
            bind:value={query}
            disabled={editing}
          />
          <div class="mac-folder-list">
            {#each folders as folder (folder.path)}<button
                type="button"
                disabled={editing}
                onclick={() => browse(folder.path)}
                >{@html icon(Folder, { size: 15 })}<span>{folder.name}</span></button
              >{:else}<p>{t('folders.empty')}</p>{/each}
          </div>
          {#if listing.truncated}<p class="mac-folder-hint">{t('folders.truncated')}</p>{/if}
          <div class="mac-folder-actions">
            <button
              class="mac-folder-select"
              type="button"
              disabled={disabled || editing}
              onclick={() => {
                onSelect(listing.path);
                close();
              }}>{t('folders.choose')}</button
            >
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .mac-folder-picker {
    margin: 10px 0 14px;
    font-size: 12px;
  }
  .mac-folder-hint {
    color: var(--text-soft);
    font-size: 11px;
    line-height: 1.7;
    margin: 8px 0 10px;
  }
  button {
    font: inherit;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--dim);
    border-radius: 8px;
    padding: 9px 11px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mac-folder-browser {
    border: 1px solid var(--dim);
    padding: 12px;
    border-radius: 12px;
    background: var(--body-bg);
  }
  .mac-folder-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mac-folder-toolbar button:last-child {
    margin-left: auto;
  }
  .mac-folder-field,
  .mac-folder-current {
    display: flex;
    align-items: stretch;
    gap: 8px;
    min-width: 0;
  }
  .mac-folder-field :global(input) {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .mac-folder-current {
    align-items: center;
    margin: 10px 0;
  }
  .mac-folder-new {
    justify-content: center;
    flex: none;
    min-height: 42px;
    white-space: nowrap;
  }
  .mac-folder-path {
    flex: 1;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
    color: var(--text-soft);
    font-size: 11px;
  }
  .mac-folder-browser input,
  .mac-folder-create input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 10px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--dim);
    border-radius: 7px;
  }
  .mac-folder-list {
    max-height: 230px;
    overflow-y: auto;
    overscroll-behavior: contain;
    margin: 8px 0;
  }
  .mac-folder-list button {
    display: flex;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    padding: 10px 7px;
  }
  .mac-folder-list button span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .mac-folder-list button:hover {
    background: var(--hover);
  }
  .mac-folder-select {
    justify-content: center;
    background: var(--text);
    color: var(--body-bg);
  }
  .mac-folder-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mac-folder-actions button {
    flex: 1 1 auto;
    min-height: 42px;
    justify-content: center;
  }
  .mac-folder-create label {
    display: block;
    margin-bottom: 6px;
  }
  .mac-folder-create {
    display: grid;
    gap: 6px;
    margin-top: 8px;
    padding: 12px;
    border: 1px solid var(--dim);
    border-radius: 10px;
    background: var(--body-bg);
  }
  .mac-folder-create input {
    margin: 0;
  }
  .mac-folder-error {
    color: var(--danger);
    line-height: 1.7;
  }
</style>

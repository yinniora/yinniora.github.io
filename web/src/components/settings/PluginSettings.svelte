<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';

  let data = $state(null);
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);
  let section = $state('packages');
  let source = $state('');
  let name = $state('');
  let kind = $state('http');
  let url = $state('');
  let command = $state('');
  let argumentsJSON = $state('');
  const argsExample = '["-y", "example-mcp-server"]';

  async function load() {
    busy = true;
    error = '';
    try {
      data = await getJSON('/api/plugins');
    } catch {
      error = t('plugins.loadFailed');
    } finally {
      busy = false;
    }
  }

  const problemKeys = new Set([
    'changed',
    'busy',
    'invalid-source',
    'invalid-skill',
    'invalid-name',
    'duplicate-name',
    'invalid-command',
    'invalid-endpoint',
    'local-only',
  ]);

  async function change(action, fields) {
    if (busy) return false;
    busy = true;
    error = '';
    saved = false;
    try {
      data = await postJSON('/api/plugins', { action, revision: data.revision, ...fields });
      saved = true;
      return true;
    } catch (failure) {
      const code = problemKeys.has(failure.message) ? failure.message : 'operation-failed';
      error = t(`plugins.error.${code}`);
      return false;
    } finally {
      busy = false;
    }
  }

  function select(value) {
    section = value;
    source = '';
    error = '';
    saved = false;
  }

  async function installSource(event) {
    event.preventDefault();
    if (await change(section === 'packages' ? 'install-package' : 'add-skill', { source }))
      source = '';
  }

  async function addServer(event) {
    event.preventDefault();
    let args = [];
    if (kind === 'stdio' && argumentsJSON.trim()) {
      try {
        args = JSON.parse(argumentsJSON);
        if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string'))
          throw new TypeError();
      } catch {
        error = t('plugins.error.invalid-command');
        return;
      }
    }
    if (await change('add-mcp', { name: name.trim(), kind, url, command, args })) {
      name = '';
      url = '';
      command = '';
      argumentsJSON = '';
    }
  }

  function remove(action, fields) {
    if (window.confirm(t('plugins.confirmRemove'))) void change(action, fields);
  }

  onMount(load);
</script>

<section class="plugin-settings">
  <h2>{t('plugins.title')}</h2>
  {#if data && !data.local}
    <p>{t('plugins.localOnly')}</p>
  {:else if data}
    <p>{t('plugins.intro')}</p>
    <nav aria-label={t('plugins.title')}>
      {#each ['packages', 'skills', 'mcp'] as tab (tab)}
        <button
          type="button"
          class:active={tab === section}
          aria-pressed={tab === section}
          disabled={busy}
          onclick={() => select(tab)}>{t(`plugins.${tab}`)}</button
        >
      {/each}
    </nav>
    {#if section === 'packages' || section === 'skills'}
      <form onsubmit={installSource}>
        <label>
          {t(section === 'packages' ? 'plugins.packageSource' : 'plugins.skillPath')}
          <input
            required
            bind:value={source}
            disabled={busy}
            spellcheck="false"
            placeholder={section === 'packages' ? 'npm:example-pi-package' : '~/my-skill/SKILL.md'}
          />
        </label>
        <button class="primary" disabled={busy || !source.trim()} type="submit">
          {t(section === 'packages' ? 'plugins.install' : 'plugins.addSkill')}
        </button>
      </form>
      {#if section === 'packages'}
        <ul>
          {#each data.packages as item (item.id)}
            <li>
              <span>{item.label}</span>
              {#if item.removable}<button
                  type="button"
                  class="danger-button"
                  disabled={busy}
                  onclick={() => remove('remove-package', { source: item.id })}
                  >{t('plugins.remove')}</button
                >{/if}
            </li>
          {:else}<li>{t('plugins.empty')}</li>{/each}
        </ul>
      {:else}
        <p>{t('plugins.skillHint')}</p>
        <ul>
          {#each new Set(data.skills) as path (path)}
            <li>
              <span>{path}</span><button
                type="button"
                class="danger-button"
                disabled={busy}
                onclick={() => remove('remove-skill', { source: path })}
                >{t('plugins.remove')}</button
              >
            </li>
          {:else}<li>{t('plugins.empty')}</li>{/each}
        </ul>
      {/if}
    {:else}
      {#if !data.mcpEnabled}<p role="status">{t('plugins.mcpDisabled')}</p>{/if}
      <form onsubmit={addServer}>
        <label
          >{t('plugins.serverName')}<input
            required
            bind:value={name}
            disabled={busy}
            maxlength="64"
            spellcheck="false"
          /></label
        >
        <label
          >{t('plugins.transport')}
          <select bind:value={kind} disabled={busy}>
            <option value="http">{t('plugins.http')}</option>
            <option value="stdio">{t('plugins.stdio')}</option>
          </select>
        </label>
        {#if kind === 'http'}
          <label
            >{t('plugins.serverURL')}<input
              type="url"
              required
              bind:value={url}
              disabled={busy}
              placeholder="https://example.com/mcp"
              spellcheck="false"
            /></label
          >
        {:else}
          <label
            >{t('plugins.serverCommand')}<input
              required
              bind:value={command}
              disabled={busy}
              placeholder="npx"
              spellcheck="false"
            /></label
          >
          <label
            >{t('plugins.serverArgs')}<textarea
              rows="2"
              bind:value={argumentsJSON}
              disabled={busy}
              placeholder={argsExample}
              spellcheck="false"
            ></textarea></label
          >
        {/if}
        <button class="primary" disabled={busy} type="submit">{t('plugins.addServer')}</button>
      </form>
      <ul>
        {#each data.servers as server (server.name)}
          <li>
            <span>{server.name}<small>{t(`plugins.${server.kind}`)}</small></span>
            <div class="actions">
              <button
                type="button"
                disabled={busy}
                aria-pressed={server.enabled}
                onclick={() =>
                  change('toggle-mcp', { name: server.name, enabled: !server.enabled })}
              >
                {t(server.enabled ? 'plugins.disable' : 'plugins.enable')}
              </button>
              <button
                type="button"
                class="danger-button"
                disabled={busy}
                onclick={() => remove('remove-mcp', { name: server.name })}
                >{t('plugins.remove')}</button
              >
            </div>
          </li>
        {:else}<li>{t('plugins.empty')}</li>{/each}
      </ul>
    {/if}
  {/if}
  {#if busy}<p role="status">{t('plugins.working')}</p>{/if}
  {#if saved}<p role="status">{t('plugins.saved')}</p>{/if}
  {#if error}<p class="error" role="alert">
      {error} <button type="button" disabled={busy} onclick={load}>{t('common.retry')}</button>
    </p>{/if}
</section>

<style>
  .plugin-settings {
    max-width: 720px;
    margin: 0 auto;
  }
  h2 {
    margin: 0 0 12px;
  }
  p,
  small {
    color: var(--muted);
  }
  nav,
  form,
  ul {
    margin-top: 18px;
  }
  nav,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  form {
    display: grid;
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--dim);
    border-radius: 12px;
  }
  label {
    display: grid;
    gap: 6px;
  }
  input,
  select,
  textarea,
  button {
    background: var(--chrome-bg);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 8px;
    padding: 8px 12px;
    font: inherit;
  }
  input,
  select,
  textarea {
    width: 100%;
    min-width: 0;
    font-size: 16px;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  button.active,
  .primary {
    background: var(--text);
    color: var(--body-bg);
  }
  .primary {
    justify-self: start;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 1px solid var(--dim);
  }
  li > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
  }
  .error {
    color: var(--error);
  }
  @media (max-width: 900px) {
    li,
    .actions {
      align-items: flex-start;
    }
  }
</style>

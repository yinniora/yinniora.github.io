<script>
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { icon, ChevronRight, Download, Search, Terminal } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { filterCommands, groupCommands, isPaletteCommand } from './chat/slash-command.js';

  let { sessionId, open = $bindable(false), mode = 'session' } = $props();
  let stats = $state(null),
    commands = $state([]),
    query = $state('');
  let loading = $state(false),
    compacting = $state(false),
    downloading = $state(false);
  let error = $state(''),
    completed = $state(false),
    confirming = $state(false);
  let generation = 0;

  const sessionUrl = $derived('/api/pi-session?id=' + encodeURIComponent(sessionId));
  const commandUrl = $derived('/api/commands?load=1&id=' + encodeURIComponent(sessionId));
  const groups = $derived(groupCommands(filterCommands(commands, query)));
  const printNumber = (value) => Number(value || 0).toLocaleString();

  async function load(kind) {
    const request = ++generation;
    loading = true;
    error = '';
    try {
      const data = await getJSON(kind === 'commands' ? commandUrl : sessionUrl);
      if (request !== generation) return;
      if (kind === 'commands') commands = (data.commands || []).filter(isPaletteCommand);
      else stats = data;
    } catch (failure) {
      if (request === generation)
        error = t(
          failure.message === 'session is busy' ? 'piSession.busy' : 'piSession.unavailable',
        );
    } finally {
      if (request === generation) loading = false;
    }
  }

  $effect(() => {
    if (!open) {
      generation++;
      return;
    }
    query = '';
    confirming = false;
    completed = false;
    load(mode);
  });

  function insertCommand(command) {
    window.dispatchEvent(
      new CustomEvent('pi:insert-command', { detail: { sessionId, command: command.name } }),
    );
    open = false;
  }

  async function compact() {
    if (compacting) return;
    compacting = true;
    confirming = false;
    error = '';
    const request = generation;
    try {
      await postJSON(sessionUrl, {});
      if (request === generation && open) {
        completed = true;
        await load('session');
      }
    } catch (failure) {
      if (request === generation)
        error = t(
          failure.message === 'session is busy' ? 'piSession.busy' : 'piSession.compactFailed',
        );
    } finally {
      compacting = false;
    }
  }

  async function download() {
    if (downloading) return;
    downloading = true;
    error = '';
    try {
      const result = await fetch(sessionUrl + '&download=html');
      if (!result.ok) throw new Error();
      const url = URL.createObjectURL(await result.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'conversation.html';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      error = t('piSession.exportFailed');
    } finally {
      downloading = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<FullScreenSheet bind:open title={t(mode === 'commands' ? 'piCommands.title' : 'piSession.title')}>
  <div class="native-tools">
    {#if error}
      <div class="native-error" role="alert">
        {error}<button type="button" class="btn-secondary" onclick={() => load(mode)}
          >{t('common.retry')}</button
        >
      </div>
    {/if}
    {#if mode === 'commands'}
      <p>{t('piCommands.hint')}</p>
      <label class="command-search">
        {@html icon(Search, { size: 16 })}
        <input
          type="search"
          bind:value={query}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
        />
      </label>
      {#if loading}<p role="status">{t('session.loading')}</p>{/if}
      {#each groups as group (group.source)}
        <section class="command-group">
          <h3>{group.label}</h3>
          {#each group.items as item, index (index)}
            <button type="button" class="native-command" onclick={() => insertCommand(item)}>
              {@html icon(Terminal, { size: 16 })}
              <span
                ><strong>/{item.name}</strong>{#if item.description}<small>{item.description}</small
                  >{/if}</span
              >
              {@html icon(ChevronRight, { size: 15 })}
            </button>
          {/each}
        </section>
      {:else}
        {#if !loading && !error}<p role="status">{t('piCommands.empty')}</p>{/if}
      {/each}
    {:else}
      {#if loading}<p role="status">{t('session.loading')}</p>{/if}
      {#if stats}
        <dl class="native-stats">
          <div>
            <dt>{t('piSession.messages')}</dt>
            <dd>{printNumber(stats.totalMessages)}</dd>
          </div>
          <div>
            <dt>{t('piSession.tools')}</dt>
            <dd>{printNumber(stats.toolCalls)}</dd>
          </div>
          <div>
            <dt>{t('piSession.tokens')}</dt>
            <dd>{printNumber(stats.tokens?.total)}</dd>
          </div>
          <div>
            <dt>{t('piSession.cache')}</dt>
            <dd>{printNumber(stats.tokens?.cacheRead)}</dd>
          </div>
        </dl>
      {/if}
      <button
        type="button"
        class="btn-secondary native-export"
        onclick={download}
        disabled={downloading}
      >
        {@html icon(Download, { size: 17 })}{t('piSession.exportHTML')}
      </button>
      <section class="native-compact">
        <h3>{t('piSession.compact')}</h3>
        <p>{t('piSession.compactHint')}</p>
        {#if compacting}<p role="status">{t('piSession.compacting')}</p>
        {:else if confirming}
          <div class="native-actions">
            <button type="button" class="btn-secondary" onclick={() => (confirming = false)}
              >{t('common.cancel')}</button
            >
            <button type="button" class="btn-primary" onclick={compact}
              >{t('piSession.compactNow')}</button
            >
          </div>
        {:else}
          <button type="button" class="btn-secondary" onclick={() => (confirming = true)}
            >{t('piSession.compact')}</button
          >
        {/if}
        {#if completed}<p role="status">{t('piSession.compacted')}</p>{/if}
      </section>
    {/if}
  </div>
</FullScreenSheet>

<style>
  .native-tools {
    display: grid;
    gap: 14px;
  }
  p {
    margin: 0;
    color: var(--text-soft);
    line-height: 1.6;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  button {
    min-height: 40px;
  }
  .native-error {
    color: var(--danger);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .command-search {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--input-bg);
    border: 1px solid var(--workspace-edge);
    border-radius: 10px;
    padding: 0 12px;
  }
  .command-search input {
    border: 0;
    background: transparent;
    padding: 10px 0;
    min-width: 0;
    width: 100%;
    color: var(--text);
    font-size: 16px;
  }
  .command-group {
    display: grid;
    gap: 5px;
  }
  .command-group h3 {
    color: var(--text-soft);
    padding: 4px 0;
  }
  .native-command {
    text-align: left;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 9px;
    padding: 10px;
    cursor: pointer;
  }
  .native-command:hover,
  .native-command:focus-visible {
    background: var(--surface-2);
  }
  .native-command span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .native-command small {
    display: block;
    margin-top: 4px;
    line-height: 1.5;
    color: var(--text-soft);
  }
  .native-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }
  .native-stats div,
  .native-compact {
    border: 1px solid var(--dim);
    border-radius: 12px;
    background: var(--surface);
    padding: 12px;
  }
  dt {
    color: var(--text-soft);
    font-size: 12px;
  }
  dd {
    margin: 4px 0 0;
    font-size: 19px;
    font-variant-numeric: tabular-nums;
  }
  .native-export {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
  }
  .native-compact {
    display: grid;
    gap: 10px;
  }
  .native-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>

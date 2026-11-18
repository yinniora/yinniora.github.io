<script>
  import { onMount } from 'svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { t } from '../../shared/i18n.js';
  import { supportedThinkingLevels } from '../../session/chat/chat-selectors.js';
  import { icon, Trash2 } from '../../shared/icons.js';
  let profiles = $state([]),
    revision = $state(''),
    activeID = $state('');
  let loading = $state(true),
    busy = $state(false),
    error = $state(''),
    status = $state('');
  let adding = $state(false),
    label = $state(''),
    baseUrl = $state(''),
    key = $state('');
  let query = $state(''),
    selected = $state([]);
  let vision = $state(false),
    contextWindow = $state(128000),
    maxTokens = $state(8192);
  const prefix = $props.id();
  const active = $derived(profiles.find((p) => p.id === activeID));
  const appliedIDs = $derived(new Set(active?.applied?.map((m) => m.id) || []));
  const filtered = $derived(
    (active?.available || []).filter((m) =>
      `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const appliedGroups = $derived(profiles.filter((profile) => profile.applied?.length));
  const appliedCount = $derived(
    appliedGroups.reduce((count, profile) => count + profile.applied.length, 0),
  );

  function accept(data) {
    profiles = data.profiles || [];
    revision = data.revision;
    if (!profiles.some((p) => p.id === activeID)) activeID = profiles[0]?.id || '';
    selected = [];
  }
  async function load() {
    loading = true;
    try {
      accept(await getJSON('/api/model-settings'));
      error = '';
    } catch {
      error = t('models.loadFailed');
    } finally {
      loading = false;
    }
  }
  function selectProfile(id) {
    activeID = id;
    selected = [];
    query = '';
    error = '';
    status = '';
  }
  async function action(body) {
    busy = true;
    error = '';
    status = '';
    try {
      const data = await postJSON('/api/model-settings', { ...body, revision });
      accept(data);
      return data;
    } catch (failure) {
      error = t(
        failure.message?.includes('changed')
          ? 'models.changed'
          : /HTTP (401|403)/.test(failure.message || '')
            ? 'models.authFailed'
            : 'models.operationFailed',
      );
      return null;
    } finally {
      busy = false;
    }
  }
  async function add(event) {
    event.preventDefault();
    const previous = new Set(profiles.map((p) => p.id));
    const data = await action({ action: 'add', label, baseUrl, api: 'auto', key });
    if (data) {
      activeID = data.profiles.find((p) => !previous.has(p.id))?.id || activeID;
      key = '';
      label = '';
      baseUrl = '';
      adding = false;
      status = t('models.keySaved');
    }
  }
  async function refresh() {
    if (await action({ action: 'refresh', id: activeID })) status = t('models.refreshed');
  }
  async function apply() {
    if (
      await action({
        action: 'apply',
        id: activeID,
        modelIds: selected,
        vision,
        contextWindow,
        maxTokens,
      })
    )
      status = t('models.applied');
  }
  async function remove(profile, model) {
    if (await action({ action: 'remove-model', id: profile.id, modelId: model.id }))
      status = t('models.removed');
  }
  async function removeKey(profile) {
    const title = t('models.removeNamed', { label: profile.label, name: t('models.key') });
    const count = t('models.appliedList', { count: profile.applied.length });
    if (busy || !window.confirm(`${title}?\n${count}`)) return;
    if (await action({ action: 'remove-key', id: profile.id })) {
      query = '';
      status = t('common.saved');
    }
  }
  onMount(load);
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<section class="model-settings">
  <div class="model-heading">
    <div>
      <h2>{t('models.title')}</h2>
      <p>{t('models.intro')}</p>
    </div>
    <button
      type="button"
      class="primary"
      disabled={busy}
      onclick={() => {
        adding = !adding;
        key = '';
      }}>{t('models.addKey')}</button
    >
  </div>
  {#if adding}
    <form onsubmit={add} class="model-key-form">
      <label for={prefix + '-label'}>{t('models.label')}</label><input
        id={prefix + '-label'}
        bind:value={label}
        required
        maxlength="100"
        disabled={busy}
      />
      <label for={prefix + '-url'}>{t('models.baseUrl')}</label><input
        id={prefix + '-url'}
        type="url"
        bind:value={baseUrl}
        placeholder="https://api.example.com/v1"
        required
        disabled={busy}
        autocapitalize="none"
        spellcheck={false}
      />
      <label for={prefix + '-key'}>{t('models.key')}</label><input
        id={prefix + '-key'}
        type="password"
        bind:value={key}
        required
        disabled={busy}
        autocomplete="new-password"
        autocapitalize="none"
        spellcheck={false}
      />
      <p>{t('models.autoProtocol')} {t('models.keyPrivacy')}</p>
      <button
        type="submit"
        class="primary"
        disabled={busy || !key.trim() || !label.trim() || !baseUrl.trim()}
        >{t(busy ? 'models.saving' : 'models.saveKey')}</button
      >
    </form>
  {/if}
  {#if error}<p role="alert" class="model-error">
      {error} <button type="button" disabled={busy} onclick={load}>{t('models.reload')}</button>
    </p>{/if}
  {#if status}<p role="status" class="model-status">{status}</p>{/if}
  {#if loading}<p role="status">{t('models.loading')}</p>
  {:else if !profiles.length}<div class="model-empty">{t('models.noKeys')}</div>
  {:else}
    <h3>{t('models.keys')}</h3>
    <div class="model-sources">
      {#each profiles as profile (profile.id)}
        <button
          type="button"
          class="model-source"
          class:active={activeID === profile.id}
          aria-pressed={activeID === profile.id}
          disabled={busy}
          onclick={() => selectProfile(profile.id)}
        >
          <strong>{profile.label}</strong><span
            >{t(profile.hasKey ? 'models.keyConfigured' : 'models.keyUnavailable')}</span
          >
        </button>
      {/each}
    </div>
    {#if active}
      <div class="model-catalog">
        <div class="model-catalog-heading">
          <h3>{t('models.availableFor', { label: active.label })}</h3>
          <div class="model-source-actions">
            <button type="button" disabled={busy || !active.hasKey} onclick={refresh}
              >{t(busy ? 'models.working' : 'models.refresh')}</button
            >
            <button
              type="button"
              class="danger-button"
              disabled={busy}
              onclick={() => removeKey(active)}
              >{@html icon(Trash2, { size: 16 })}{t('models.remove')} {t('models.key')}</button
            >
          </div>
        </div>
        <p class="model-endpoint">{active.baseUrl}</p>
        <input
          type="search"
          aria-label={t('models.search')}
          placeholder={t('models.search')}
          bind:value={query}
          disabled={busy}
        />
        <div class="model-selection-tools">
          <button
            type="button"
            disabled={busy}
            onclick={() =>
              (selected = [
                ...new Set([
                  ...selected,
                  ...filtered.filter((m) => !appliedIDs.has(m.id)).map((m) => m.id),
                ]),
              ])}>{t('models.selectAll')}</button
          ><button type="button" disabled={busy || !selected.length} onclick={() => (selected = [])}
            >{t('models.clearSelection')}</button
          ><span>{t('models.selectedCount', { count: selected.length })}</span>
        </div>
        <div class="model-available-list">
          {#each filtered as model (model.id)}
            <label class="model-choice"
              ><input
                type="checkbox"
                value={model.id}
                bind:group={selected}
                disabled={busy || appliedIDs.has(model.id)}
              /><span
                ><strong>{model.name || model.id}</strong
                >{#if model.name && model.name !== model.id}<small>{model.id}</small>{/if}</span
              >{#if appliedIDs.has(model.id)}<em>{t('models.inUse')}</em>{/if}</label
            >
          {:else}<p>{t('models.refreshHint')}</p>{/each}
        </div>
        <details>
          <summary>{t('models.capabilities')}</summary>
          <div class="model-options">
            <label
              ><input type="checkbox" bind:checked={vision} disabled={busy} />{t(
                'models.vision',
              )}</label
            >
            <label for={prefix + '-context'}
              >{t('models.contextWindow')}<input
                id={prefix + '-context'}
                type="number"
                min="1"
                max="10000000"
                bind:value={contextWindow}
                disabled={busy}
              /></label
            >
            <label for={prefix + '-tokens'}
              >{t('models.maxTokens')}<input
                id={prefix + '-tokens'}
                type="number"
                min="1"
                max="1000000"
                bind:value={maxTokens}
                disabled={busy}
              /></label
            >
          </div>
          <p>{t('models.capabilitiesHint')}</p>
        </details>
        <button type="button" class="primary" disabled={busy || !selected.length} onclick={apply}
          >{t('models.applySelected', { count: selected.length })}</button
        >
      </div>
    {/if}
  {/if}
  <div class="model-applied">
    <h3>{t('models.appliedList', { count: appliedCount })}</h3>
    <p>{t('models.appliedHint')}</p>
    {#each appliedGroups as profile (profile.id)}
      <section class="model-applied-group" aria-label={profile.label}>
        <h4>{profile.label}</h4>
        {#each profile.applied as model (model.id)}
          <div class="model-applied-row">
            <div>
              <strong>{model.name || model.id}</strong>
              {#if model.name && model.name !== model.id}<small>{model.id}</small>{/if}
              {#if supportedThinkingLevels(model).length > 1}<small>
                  {t('models.effortAvailable')}
                </small>{/if}
            </div>
            <button
              type="button"
              class="danger-button"
              disabled={busy}
              aria-label={t('models.removeNamed', {
                name: model.name || model.id,
                label: profile.label,
              })}
              onclick={() => remove(profile, model)}
              >{@html icon(Trash2, { size: 16 })}{t('models.remove')}</button
            >
          </div>
        {/each}
      </section>
    {:else}<p>{t('models.noApplied')}</p>{/each}
  </div>
</section>

<style>
  .model-settings {
    max-width: 860px;
    min-width: 0;
    color: var(--text);
  }
  h2 {
    font-size: 20px;
    margin: 0 0 8px;
  }
  h3 {
    font-size: 14px;
    margin: 18px 0 10px;
  }
  p {
    color: var(--text-soft);
    font-size: 13px;
    line-height: 1.7;
    margin: 8px 0;
  }
  button,
  input {
    font: inherit;
    box-sizing: border-box;
  }
  button {
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--dim);
    border-radius: 10px;
    padding: 9px 12px;
    cursor: pointer;
    min-height: 40px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: var(--text);
    color: var(--body-bg);
  }
  input:not([type='checkbox']) {
    width: 100%;
    min-width: 0;
    padding: 10px;
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 9px;
    font-size: 16px;
  }
  .model-heading,
  .model-catalog-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .model-heading > div {
    min-width: 0;
  }
  .model-heading > button {
    flex: none;
  }
  .model-key-form,
  .model-catalog,
  .model-applied {
    border: 1px solid var(--dim);
    border-radius: 16px;
    padding: 16px;
    margin: 18px 0;
    min-width: 0;
  }
  .model-key-form > label {
    display: block;
    margin: 14px 0 6px;
    font-size: 13px;
  }
  .model-key-form > button {
    margin-top: 10px;
  }
  .model-sources {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
    gap: 10px;
  }
  .model-source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    text-align: left;
  }
  .model-source strong {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .model-source.active {
    border-color: var(--accent);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .model-source span {
    font-size: 11px;
    color: var(--text-soft);
  }
  .model-catalog-heading h3 {
    margin: 0;
  }
  .model-source-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .model-endpoint {
    overflow-wrap: anywhere;
    font-size: 11px;
  }
  .model-selection-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .model-selection-tools span {
    margin-left: auto;
    color: var(--text-soft);
  }
  .model-available-list {
    max-height: 340px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .model-choice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 2px;
    border-bottom: 1px solid var(--dim);
    cursor: pointer;
  }
  .model-choice > span {
    flex: 1;
    min-width: 0;
  }
  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }
  .model-choice strong,
  .model-applied strong {
    font-size: 13px;
    font-weight: 500;
  }
  small {
    color: var(--text-soft);
    font-size: 11px;
    margin-top: 4px;
  }
  em {
    font-size: 10px;
    color: var(--text-soft);
    font-style: normal;
    flex: none;
  }
  input[type='checkbox'] {
    flex: none;
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }
  details {
    margin: 16px 0;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    padding: 8px 0;
  }
  .model-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 8px;
  }
  .model-options label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .model-applied-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 0;
    border-top: 1px solid var(--dim);
  }
  .model-applied-row > div {
    flex: 1;
    min-width: 0;
  }
  .danger-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    gap: 6px;
    min-height: 40px;
  }
  .model-applied-group h4 {
    margin: 16px 0 4px;
    color: var(--text-soft);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .model-error {
    color: var(--error, #cf5f5f);
  }
  .model-status {
    color: var(--accent);
  }
  .model-empty {
    padding: 24px 0;
    color: var(--text-soft);
  }
  @media (max-width: 760px) {
    .model-heading,
    .model-catalog-heading {
      align-items: flex-start;
      flex-direction: column;
    }
    .model-key-form,
    .model-catalog,
    .model-applied {
      padding: 12px;
    }
    .model-applied-row button {
      padding-inline: 8px;
    }
  }
</style>

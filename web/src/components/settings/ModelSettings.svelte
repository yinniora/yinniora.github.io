<script>
  import { onMount } from 'svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { t } from '../../shared/i18n.js';
  import { supportedThinkingLevels } from '../../session/chat/chat-selectors.js';
  import { loadModelBalances, modelBalanceLabel } from '../../session/chat/model-balances.js';
  import { icon, Pencil, Trash2 } from '../../shared/icons.js';
  const apiLabels = {
    'openai-completions': 'models.openaiCompatible',
    'openai-responses': 'models.openaiResponses',
    'anthropic-messages': 'models.anthropic',
    'google-generative-ai': 'models.gemini',
  };
  let profiles = $state([]),
    revision = $state(''),
    activeID = $state('');
  let loading = $state(true),
    busy = $state(false),
    error = $state(''),
    status = $state('');
  let keyFormMode = $state(''),
    label = $state(''),
    baseUrl = $state(''),
    key = $state('');
  let query = $state(''),
    selected = $state([]);
  let balances = $state({});
  let loadingBalances = $state(false);
  let balanceRequest;
  let mounted = false;
  let vision = $state(false),
    contextWindow = $state(undefined),
    maxTokens = $state(undefined);
  let limitEditor = $state(null);
  const prefix = $props.id();
  const active = $derived(profiles.find((p) => p.id === activeID));
  const catalogAPIs = $derived([
    ...new Set((active?.available || []).map((model) => model.api).filter(Boolean)),
  ]);
  const newServer = $derived.by(() => {
    if (keyFormMode !== 'edit' || !active?.baseUrl) return false;
    try {
      return new URL(baseUrl.trim()).origin !== new URL(active.baseUrl).origin;
    } catch {
      return false;
    }
  });
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
    if (!profiles.some((p) => p.id === activeID)) {
      if (keyFormMode === 'edit') closeKeyForm();
      activeID = profiles[0]?.id || '';
    }
    selected = [];
    void refreshBalances();
  }
  async function refreshBalances() {
    if (!mounted) return;
    balanceRequest?.abort();
    if (!profiles.some((profile) => profile.hasKey)) {
      balances = {};
      loadingBalances = false;
      return;
    }
    const request = new AbortController();
    balanceRequest = request;
    loadingBalances = true;
    try {
      const result = await loadModelBalances({ signal: request.signal });
      if (!request.signal.aborted) balances = result;
    } catch {
      if (!request.signal.aborted) balances = {};
    } finally {
      if (!request.signal.aborted) loadingBalances = false;
    }
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
    if (keyFormMode === 'edit' && id !== activeID) closeKeyForm();
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
      const message = failure.message || '';
      const editErrors = {
        'enter a new key for a different API server': 'models.newServerKey',
        'provider has custom authentication or routes': 'models.customEndpoint',
        'provider has a different sign-in method': 'models.otherCredential',
        'enter an API key to check compatibility': 'models.keyForCheck',
      };
      error = t(
        editErrors[message] ||
          (message.includes('changed')
            ? 'models.changed'
            : /HTTP (401|403)/.test(message)
              ? 'models.authFailed'
              : 'models.operationFailed'),
      );
      return null;
    } finally {
      busy = false;
    }
  }
  function closeKeyForm() {
    keyFormMode = '';
    label = '';
    baseUrl = '';
    key = '';
    error = '';
  }
  function openKeyForm(profile = null) {
    const mode = profile ? 'edit' : 'add';
    const wasOpen = keyFormMode === mode;
    closeKeyForm();
    if (wasOpen) return;
    keyFormMode = mode;
    label = profile?.label || '';
    baseUrl = profile?.baseUrl || '';
    status = '';
  }
  async function saveKey(event) {
    event.preventDefault();
    if (busy) return;
    const editing = keyFormMode === 'edit';
    const source = active;
    const previous = new Set(profiles.map((p) => p.id));
    const data = await action({
      ...(editing ? { action: 'edit', id: activeID } : { action: 'add', api: 'auto' }),
      label,
      baseUrl,
      key,
    });
    if (data) {
      if (editing) {
        if (key.trim() || baseUrl.trim() !== source?.baseUrl) delete balances[activeID];
      } else {
        activeID = data.profiles.find((p) => !previous.has(p.id))?.id || activeID;
      }
      closeKeyForm();
      status = t(editing ? 'models.keyUpdated' : 'models.keySaved');
    }
  }
  async function refresh() {
    if (await action({ action: 'refresh', id: activeID })) status = t('models.refreshed');
  }
  async function checkAPI(profile) {
    if (
      await action({
        action: 'edit',
        id: profile.id,
        label: profile.label,
        baseUrl: profile.baseUrl,
        checkApi: true,
      })
    ) {
      status = t('models.apiChecked');
    }
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
  async function saveLimits(event) {
    event.preventDefault();
    if (busy || !limitEditor) return;
    if (await action({ action: 'edit-limits', ...limitEditor })) {
      limitEditor = null;
      status = t('common.saved');
    }
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
      if (keyFormMode === 'edit') closeKeyForm();
      query = '';
      status = t('common.saved');
    }
  }
  onMount(() => {
    mounted = true;
    void load();
    return () => {
      mounted = false;
      balanceRequest?.abort();
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
{#snippet keyForm(editing)}
  <form onsubmit={saveKey} class="model-key-form">
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
      required={!editing || newServer}
      disabled={busy}
      maxlength="8192"
      autocomplete="new-password"
      autocapitalize="none"
      spellcheck={false}
      aria-describedby={prefix + '-key-hint'}
    />
    <p id={prefix + '-key-hint'}>
      {#if editing}
        {t(newServer ? 'models.newServerKey' : 'models.keepKey')}
      {:else}
        {t('models.autoProtocol')} {t('models.keyPrivacy')}
      {/if}
    </p>
    {#if editing && error}
      <p role="alert" class="model-error">
        {error} <button type="button" disabled={busy} onclick={load}>{t('models.reload')}</button>
      </p>
    {/if}
    <div class="model-key-actions">
      <button type="button" disabled={busy} onclick={closeKeyForm}>{t('common.cancel')}</button>
      <button
        type="submit"
        class="primary"
        disabled={busy ||
          ((!editing || newServer) && !key.trim()) ||
          !label.trim() ||
          !baseUrl.trim()}
        >{t(busy ? 'models.saving' : editing ? 'common.save' : 'models.saveKey')}</button
      >
    </div>
  </form>
{/snippet}

<section class="model-settings">
  <div class="model-heading">
    <div>
      <h2>{t('models.title')}</h2>
      <p>{t('models.intro')}</p>
    </div>
    <button type="button" class="primary" disabled={busy} onclick={() => openKeyForm()}
      >{t('models.addKey')}</button
    >
  </div>
  {#if keyFormMode === 'add'}{@render keyForm(false)}{/if}
  {#if error && keyFormMode !== 'edit'}<p role="alert" class="model-error">
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
          {#if profile.hasKey}
            <span class="model-source-balance">
              {modelBalanceLabel(
                Object.hasOwn(balances, profile.id) ? balances[profile.id] : null,
              ) || t(loadingBalances ? 'models.balanceLoading' : 'models.balanceUnavailable')}
            </span>
          {/if}
        </button>
      {/each}
    </div>
    {#if active}
      <div class="model-catalog">
        <div class="model-catalog-heading">
          <h3>{t('models.availableFor', { label: active.label })}</h3>
          <div class="model-source-actions">
            <button
              type="button"
              disabled={busy}
              aria-expanded={keyFormMode === 'edit'}
              onclick={() => openKeyForm(active)}
              >{@html icon(Pencil, { size: 15 })}{t('models.editKey')}</button
            >
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
        {#if active.api}
          <div class="model-protocol">
            <div>
              <strong
                >{t('models.apiType', {
                  api: apiLabels[active.api] ? t(apiLabels[active.api]) : active.api,
                })}</strong
              >
              {#if active.catalogVerified}
                <small
                  >{t('models.catalogVerified', { count: active.available?.length || 0 })}</small
                >
                {#if catalogAPIs.length > 1}
                  <small>
                    {t('models.catalogProtocols', {
                      apis: catalogAPIs
                        .map((api) => (apiLabels[api] ? t(apiLabels[api]) : api))
                        .join(' / '),
                    })}
                  </small>
                {/if}
              {/if}
            </div>
            <button
              type="button"
              disabled={busy || !active.hasKey || keyFormMode !== ''}
              onclick={() => checkAPI(active)}>{t('models.checkApi')}</button
            >
          </div>
        {/if}
        {#if keyFormMode === 'edit'}{@render keyForm(true)}{/if}
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
                >{#if model.name && model.name !== model.id}<small>{model.id}</small>{/if}
                {#if model.contextWindow}<small
                    >{t('models.contextWindow')} · {model.contextWindow.toLocaleString()}</small
                  >{/if}</span
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
              {#if model.contextWindow}<small
                  >{t('models.contextWindow')} · {model.contextWindow.toLocaleString()}</small
                >{/if}
              {#if model.maxTokens}<small
                  >{t('models.maxTokens')} · {model.maxTokens.toLocaleString()}</small
                >{/if}
              {#if supportedThinkingLevels(model).length > 1}<small>
                  {t('models.effortAvailable')}
                </small>{/if}
            </div>
            <button
              type="button"
              class="limit-edit-button"
              disabled={busy}
              aria-label={t('models.contextWindow') + ' · ' + (model.name || model.id)}
              aria-expanded={limitEditor?.id === profile.id && limitEditor?.modelId === model.id}
              onclick={() =>
                (limitEditor =
                  limitEditor?.id === profile.id && limitEditor?.modelId === model.id
                    ? null
                    : {
                        id: profile.id,
                        modelId: model.id,
                        contextWindow: model.contextWindow,
                        maxTokens: model.maxTokens,
                      })}>{@html icon(Pencil, { size: 16 })}</button
            >
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
          {#if limitEditor?.id === profile.id && limitEditor?.modelId === model.id}
            <form class="model-limit-form" onsubmit={saveLimits}>
              <div class="model-options">
                <label>
                  {t('models.contextWindow')}
                  <input
                    type="number"
                    min="1"
                    max="10000000"
                    required
                    bind:value={limitEditor.contextWindow}
                    disabled={busy}
                  />
                </label>
                <label>
                  {t('models.maxTokens')}
                  <input
                    type="number"
                    min="1"
                    max="1000000"
                    required
                    bind:value={limitEditor.maxTokens}
                    disabled={busy}
                  />
                </label>
              </div>
              <div class="model-limit-actions">
                <button type="button" disabled={busy} onclick={() => (limitEditor = null)}
                  >{t('common.cancel')}</button
                >
                <button type="submit" class="primary" disabled={busy}>{t('common.save')}</button>
              </div>
            </form>
          {/if}
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
  .model-key-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
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
  .model-source .model-source-balance {
    color: var(--text);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
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
  .model-protocol {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 8px 0 14px;
    font-size: 12px;
  }
  .model-protocol button {
    flex: none;
    font-size: 12px;
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
  .limit-edit-button {
    display: grid;
    place-items: center;
    flex: none;
    min-width: 40px;
    padding: 8px;
  }
  .model-limit-form {
    padding: 4px 12px 12px;
    margin-bottom: 10px;
    background: var(--surface-2);
    border-radius: 12px;
  }
  .model-limit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
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

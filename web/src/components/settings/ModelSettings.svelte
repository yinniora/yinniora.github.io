<script>
  import { onMount } from 'svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { t } from '../../shared/i18n.js';
  import { supportedThinkingLevels } from '../../session/chat/chat-selectors.js';
  import { loadModelBalances, modelBalanceLabel } from '../../session/chat/model-balances.js';
  import {
    formatTokenLimit,
    parseTokenLimit,
    MAX_TOKEN_LIMIT,
  } from '../../settings/model-token-limits.js';
  import { icon, Gauge, Image, Pencil, Search, Trash2 } from '../../shared/icons.js';
  const openAIBaseURL = 'https://api.openai.com/v1';
  const catalogFilters = [
    { id: 'all', label: 'session.filterAll' },
    { id: 'reasoning', label: 'models.effortAvailable', icon: Gauge },
    { id: 'vision', label: 'models.vision', icon: Image },
    { id: 'applied', label: 'models.inUse' },
  ];
  const apiLabels = {
    'openai-completions': 'models.openaiCompatible',
    'openai-responses': 'models.openaiResponses',
    'anthropic-messages': 'models.anthropic',
    'google-generative-ai': 'models.gemini',
  };
  let { standalone = false } = $props();
  let profiles = $state([]),
    revision = $state(''),
    activeID = $state('');
  let loading = $state(true),
    busy = $state(false),
    error = $state(''),
    status = $state('');
  let keyFormMode = $state(''),
    replacingKey = $state(false),
    label = $state(''),
    baseUrl = $state(''),
    key = $state('');
  let query = $state(''),
    catalogFilter = $state('all'),
    selected = $state([]);
  let balances = $state({});
  let loadingBalances = $state(false);
  let balanceRequest;
  let mounted = false;
  let vision = $state(false),
    contextWindow = $state(''),
    maxTokens = $state('');
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
  const selectedIDs = $derived(new Set(selected));
  const filtered = $derived.by(() => {
    const terms = query.toLowerCase().trim().split(/\s+/);
    return (active?.available || []).filter((model) => {
      const searchable = `${model.name || ''} ${model.id}`.toLowerCase();
      if (!terms.every((term) => searchable.includes(term))) return false;
      if (catalogFilter === 'reasoning') return supportedThinkingLevels(model).length > 1;
      if (catalogFilter === 'vision') return model.input?.includes('image');
      if (catalogFilter === 'applied') return appliedIDs.has(model.id);
      return true;
    });
  });
  const selectableResults = $derived(filtered.filter((model) => !appliedIDs.has(model.id)));
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
    catalogFilter = 'all';
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
    replacingKey = false;
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
    baseUrl = profile?.baseUrl || openAIBaseURL;
    status = '';
  }
  async function saveKey(event) {
    event.preventDefault();
    if (busy) return;
    const editing = keyFormMode === 'edit';
    const source = active;
    const replacement = !editing || replacingKey || newServer || !source?.hasKey ? key.trim() : '';
    const previous = new Set(profiles.map((p) => p.id));
    const data = await action({
      ...(editing ? { action: 'edit', id: activeID } : { action: 'add', api: 'auto' }),
      label,
      baseUrl,
      ...(replacement ? { key: replacement } : {}),
    });
    if (data) {
      if (editing) {
        if (replacement || baseUrl.trim() !== source?.baseUrl) delete balances[activeID];
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
    const context = parseTokenLimit(contextWindow, MAX_TOKEN_LIMIT);
    const output = parseTokenLimit(maxTokens, MAX_TOKEN_LIMIT);
    if (context === null || output === null) return;
    if (
      await action({
        action: 'apply',
        id: activeID,
        modelIds: selected,
        vision,
        contextWindow: context,
        maxTokens: output,
      })
    )
      status = t('models.applied');
  }
  async function saveLimits(event) {
    event.preventDefault();
    if (busy || !limitEditor) return;
    const context = parseTokenLimit(limitEditor.contextWindow, MAX_TOKEN_LIMIT);
    const output = parseTokenLimit(limitEditor.maxTokens, MAX_TOKEN_LIMIT);
    if (!context || !output) return;
    if (
      await action({
        action: 'edit-limits',
        ...limitEditor,
        contextWindow: context,
        maxTokens: output,
      })
    ) {
      limitEditor = null;
      status = t('common.saved');
    }
  }
  async function saveThinkingDefault(profile, model, select) {
    const result = await action({
      action: 'edit-thinking-default',
      id: profile.id,
      modelId: model.id,
      thinkingLevel: select.value,
    });
    if (result) status = t('common.saved');
    else select.value = model.defaultThinkingLevel || '';
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
  {@const keyRequired = !editing || newServer}
  <form onsubmit={saveKey} class="model-key-form" autocomplete="off">
    <label for={prefix + '-label'}>{t('models.label')}</label><input
      id={prefix + '-label'}
      bind:value={label}
      required
      maxlength="100"
      disabled={busy}
    />
    <div class="model-endpoint-label">
      <label for={prefix + '-url'}>{t('models.baseUrl')}</label>
      <button
        type="button"
        aria-pressed={baseUrl.trim() === openAIBaseURL}
        disabled={busy}
        onclick={() => (baseUrl = openAIBaseURL)}>OpenAI</button
      >
    </div>
    <input
      id={prefix + '-url'}
      type="url"
      bind:value={baseUrl}
      placeholder="https://api.example.com/v1"
      required
      disabled={busy}
      autocapitalize="none"
      spellcheck={false}
    />
    {#if keyRequired || replacingKey || !active?.hasKey}
      <label for={prefix + '-token-entry'}>{t('models.key')}</label>
      <input
        id={prefix + '-token-entry'}
        class="pi-secret-token"
        type="text"
        bind:value={key}
        required={keyRequired}
        disabled={busy}
        maxlength="8192"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck={false}
        aria-describedby={prefix + '-key-hint'}
      />
      <p id={prefix + '-key-hint'}>
        {#if editing}
          {t(newServer ? 'models.newServerKey' : 'models.keyPrivacy')}
        {:else}
          {t('models.autoProtocol')} {t('models.keyPrivacy')}
        {/if}
      </p>
    {:else}
      <div class="model-saved-key">
        <div>
          <strong>{t('models.keyConfigured')}</strong>
          <p>{t('models.keyPrivacy')}</p>
        </div>
        <button type="button" disabled={busy} onclick={() => (replacingKey = true)}>
          {t('models.editKey')}
        </button>
      </div>
    {/if}
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
        disabled={busy || (keyRequired && !key.trim()) || !label.trim() || !baseUrl.trim()}
        >{t(busy ? 'models.saving' : editing ? 'common.save' : 'models.saveKey')}</button
      >
    </div>
  </form>
{/snippet}

<section class="model-settings">
  <div class="model-heading">
    <div>
      {#if !standalone}<h2>{t('models.title')}</h2>{/if}
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
            {#if keyFormMode !== 'edit'}
              <button type="button" disabled={busy} onclick={() => openKeyForm(active)}
                >{@html icon(Pencil, { size: 15 })}{t('models.editKey')}</button
              >
            {/if}
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
        <div class="model-search">
          <span aria-hidden="true">{@html icon(Search, { size: 17 })}</span>
          <input
            type="search"
            aria-label={t('models.search')}
            placeholder={t('models.search')}
            bind:value={query}
            disabled={busy}
          />
        </div>
        <div class="model-filters">
          {#each catalogFilters as filter (filter.id)}
            <button
              type="button"
              aria-pressed={catalogFilter === filter.id}
              disabled={busy}
              onclick={() => (catalogFilter = filter.id)}
            >
              {#if filter.icon}{@html icon(filter.icon, { size: 14 })}{/if}
              {t(filter.label)}
            </button>
          {/each}
        </div>
        <div class="model-selection-tools">
          <button
            type="button"
            disabled={busy || !selectableResults.length}
            onclick={() =>
              (selected = [...new Set([...selected, ...selectableResults.map((m) => m.id)])])}
            >{t('models.selectAll')}</button
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
                checked={selectedIDs.has(model.id) || appliedIDs.has(model.id)}
                onchange={(event) =>
                  (selected = event.currentTarget.checked
                    ? [...selected, model.id]
                    : selected.filter((id) => id !== model.id))}
                disabled={busy || appliedIDs.has(model.id)}
              /><span
                ><strong>{model.name || model.id}</strong
                >{#if model.name && model.name !== model.id}<small>{model.id}</small>{/if}
                {#if apiLabels[model.api]}<small>{t(apiLabels[model.api])}</small>{/if}
                {#if model.contextWindow}<small
                    >{t('models.contextWindow')} · {formatTokenLimit(model.contextWindow)}</small
                  >{/if}</span
              >{#if appliedIDs.has(model.id)}<em>{t('models.inUse')}</em>{/if}</label
            >
          {:else}
            <p class="model-no-results">
              {t(
                active.available?.length || active.catalogVerified
                  ? 'models.noMatches'
                  : 'models.refreshHint',
              )}
            </p>
          {/each}
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
                type="text"
                placeholder="1M"
                maxlength="24"
                autocomplete="off"
                aria-invalid={parseTokenLimit(contextWindow, MAX_TOKEN_LIMIT) === null}
                bind:value={contextWindow}
                disabled={busy}
              /></label
            >
            <label for={prefix + '-tokens'}
              >{t('models.maxTokens')}<input
                id={prefix + '-tokens'}
                type="text"
                placeholder="128K"
                maxlength="24"
                autocomplete="off"
                aria-invalid={parseTokenLimit(maxTokens, MAX_TOKEN_LIMIT) === null}
                bind:value={maxTokens}
                disabled={busy}
              /></label
            >
          </div>
          <p>{t('models.capabilitiesHint')}</p>
        </details>
        <button
          type="button"
          class="primary"
          disabled={busy ||
            !selected.length ||
            parseTokenLimit(contextWindow, MAX_TOKEN_LIMIT) === null ||
            parseTokenLimit(maxTokens, MAX_TOKEN_LIMIT) === null}
          onclick={apply}>{t('models.applySelected', { count: selected.length })}</button
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
              {#if apiLabels[model.api]}<small>{t(apiLabels[model.api])}</small>{/if}
              {#if model.contextWindow}<small
                  >{t('models.contextWindow')} · {formatTokenLimit(model.contextWindow)}</small
                >{/if}
              {#if model.maxTokens}<small
                  >{t('models.maxTokens')} · {formatTokenLimit(model.maxTokens)}</small
                >{/if}
              {#if supportedThinkingLevels(model).length > 1}<small>
                  {t('models.effortAvailable')}
                  {#if model.api === 'anthropic-messages'}
                    · {model.adaptiveThinking ? 'effort' : 'budget_tokens'}
                  {/if}
                  {#if model.defaultThinkingLevel}
                    · {t('schedules.thinkingDefault')} {t('thinking.' + model.defaultThinkingLevel)}
                  {/if}
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
                        contextWindow: formatTokenLimit(
                          model.contextWindow || model.defaultContextWindow,
                        ),
                        maxTokens: formatTokenLimit(model.maxTokens || model.defaultMaxTokens),
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
                <div class="model-limit-field">
                  <label for={prefix + '-edit-context'}>{t('models.contextWindow')}</label>
                  <input
                    id={prefix + '-edit-context'}
                    type="text"
                    placeholder="1M"
                    maxlength="24"
                    autocomplete="off"
                    aria-invalid={parseTokenLimit(limitEditor.contextWindow, MAX_TOKEN_LIMIT) ===
                      null}
                    required
                    bind:value={limitEditor.contextWindow}
                    disabled={busy}
                  />
                  {#if model.defaultContextWindow}
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() =>
                        (limitEditor.contextWindow = formatTokenLimit(model.defaultContextWindow))}
                      >{t('schedules.thinkingDefault')} · {formatTokenLimit(
                        model.defaultContextWindow,
                      )}</button
                    >
                  {/if}
                </div>
                <div class="model-limit-field">
                  <label for={prefix + '-edit-output'}>{t('models.maxTokens')}</label>
                  <input
                    id={prefix + '-edit-output'}
                    type="text"
                    placeholder="128K"
                    maxlength="24"
                    autocomplete="off"
                    aria-invalid={parseTokenLimit(limitEditor.maxTokens, MAX_TOKEN_LIMIT) === null}
                    required
                    bind:value={limitEditor.maxTokens}
                    disabled={busy}
                  />
                  {#if model.defaultMaxTokens}
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() =>
                        (limitEditor.maxTokens = formatTokenLimit(model.defaultMaxTokens))}
                      >{t('schedules.thinkingDefault')} · {formatTokenLimit(
                        model.defaultMaxTokens,
                      )}</button
                    >
                  {/if}
                </div>
                {#if supportedThinkingLevels(model).length > 1}
                  <label>
                    {t('models.effortAvailable')} · {t('schedules.thinkingDefault')}
                    <select
                      value={model.defaultThinkingLevel || ''}
                      disabled={busy}
                      onchange={(event) => saveThinkingDefault(profile, model, event.currentTarget)}
                    >
                      <option value="">{t('schedules.thinkingDefault')}</option>
                      {#each supportedThinkingLevels(model) as level (level)}
                        <option value={level}>{t('thinking.' + level)}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
              </div>
              <div class="model-limit-actions">
                <button type="button" disabled={busy} onclick={() => (limitEditor = null)}
                  >{t('common.cancel')}</button
                >
                <button
                  type="submit"
                  class="primary"
                  disabled={busy ||
                    !parseTokenLimit(limitEditor.contextWindow, MAX_TOKEN_LIMIT) ||
                    !parseTokenLimit(limitEditor.maxTokens, MAX_TOKEN_LIMIT)}
                  >{t('common.save')}</button
                >
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
  input[aria-invalid='true'] {
    border-color: var(--error);
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
  .model-endpoint-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin: 12px 0 6px;
    font-size: 13px;
  }
  .model-endpoint-label button,
  .model-filters button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 5px 9px;
    background: var(--surface);
    border-radius: 8px;
    font-size: 12px;
  }
  .model-endpoint-label button[aria-pressed='true'],
  .model-filters button[aria-pressed='true'] {
    background: var(--surface-2);
    border-color: var(--accent);
  }
  .model-saved-key {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--dim);
    border-radius: 10px;
    background: var(--surface);
  }
  .model-saved-key strong {
    font-size: 13px;
    font-weight: 600;
  }
  .model-saved-key p {
    margin: 2px 0 0;
  }
  .model-saved-key > button {
    flex: none;
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
  .model-search {
    position: relative;
    margin-top: 12px;
  }
  .model-search > span {
    display: grid;
    place-items: center;
    position: absolute;
    inset-block: 0;
    inset-inline-start: 12px;
    pointer-events: none;
    color: var(--text-soft);
  }
  .model-search input {
    min-height: 44px;
    padding-inline-start: 36px;
  }
  .model-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .model-no-results {
    padding: 8px 0;
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
  .model-limit-form select {
    width: 100%;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 8px;
    padding: 7px 8px;
    min-height: 44px;
    font-size: 16px;
  }
  .model-options label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .model-limit-field {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
  }
  .model-limit-field button {
    justify-self: start;
    min-height: 36px;
    padding: 6px 9px;
    font-size: 12px;
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

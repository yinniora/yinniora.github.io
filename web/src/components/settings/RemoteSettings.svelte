<script>
  import { onMount } from 'svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { t } from '../../shared/i18n.js';
  let { showDevices = true } = $props();
  const prefix = $props.id();
  let enabled = $state(false),
    loading = $state(true),
    busy = $state(false),
    error = $state(''),
    saved = $state(false);
  let serverUrl = $state(''),
    room = $state(''),
    hostToken = $state(''),
    turnSecret = $state(''),
    clientSecret = $state(''),
    hasSecrets = $state(false),
    configuration = $state('');
  function apply(value) {
    serverUrl = value.serverUrl || '';
    room = value.room || '';
    hasSecrets = !!(value.hasHostToken && value.hasTurnSecret && value.hasClientSecret);
    hostToken = '';
    turnSecret = '';
    clientSecret = '';
    configuration = '';
  }
  function importConfiguration() {
    try {
      if (configuration.length > 8192) throw new Error();
      const data = JSON.parse(configuration);
      serverUrl = String(data.serverUrl || serverUrl);
      room = String(data.room || '');
      hostToken = String(data.hostToken || '');
      turnSecret = String(data.turnSecret || '');
      clientSecret = String(data.clientSecret || '');
      configuration = '';
      error = '';
    } catch {
      error = t('remoteSettings.invalidImport');
    }
  }
  async function save(event) {
    event.preventDefault();
    busy = true;
    error = '';
    saved = false;
    try {
      const data = await postJSON('/api/remote-settings', {
        serverUrl,
        room,
        hostToken,
        turnSecret,
        clientSecret,
      });
      apply(data.settings);
      saved = true;
      window.dispatchEvent(new Event('pi:remote-config-saved'));
    } catch (failure) {
      const message = failure.message || '';
      error = t(
        message.includes('Mac authentication')
          ? 'remoteSettings.macAuthFailed'
          : message.includes('HTTPS')
            ? 'remoteSettings.httpsFailed'
            : message.includes('credential') || message.includes('routing ID')
              ? 'remoteSettings.credentialsFailed'
              : 'remoteSettings.saveFailed',
      );
    } finally {
      busy = false;
    }
  }
  onMount(async () => {
    try {
      const data = await getJSON('/api/remote-settings');
      enabled = !!data.enabled;
      if (data.settings) apply(data.settings);
    } catch {
      error = t('remoteSettings.macOnly');
    } finally {
      loading = false;
    }
  });
</script>

<section class="remote-settings">
  <h3>{t('remoteSettings.title')}</h3>
  <p>{t('remoteSettings.intro')}</p>
  {#if loading}<p role="status">{t('remoteSettings.loading')}</p>
  {:else if !enabled}<p>{error || t('remoteSettings.setupRequired')}</p>
  {:else}
    <p class="remote-auto-hint">{t('remoteSettings.automatic')}</p>
    <form onsubmit={save} autocomplete="off">
      <label for={prefix + '-server-url'}>{t('remoteSettings.server')}</label><input
        id={prefix + '-server-url'}
        type="url"
        placeholder="https://relay.example.com"
        bind:value={serverUrl}
        disabled={busy}
        required
      />
      <details>
        <summary>{t('remoteSettings.import')}</summary><textarea
          aria-label={t('remoteSettings.configuration')}
          bind:value={configuration}
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          rows="3"
        ></textarea><button
          type="button"
          disabled={busy || !configuration.trim()}
          onclick={importConfiguration}>{t('remoteSettings.importButton')}</button
        >
      </details>
      <details>
        <summary>{t('remoteSettings.credentials')}</summary>
        <p>{t(hasSecrets ? 'remoteSettings.keepSecrets' : 'remoteSettings.credentialsHint')}</p>
        <label for={prefix + '-room'}>{t('remoteSettings.room')}</label><input
          id={prefix + '-room'}
          bind:value={room}
          disabled={busy}
          autocomplete="off"
        />
        <label for={prefix + '-host-token'}>{t('remoteSettings.hostToken')}</label><input
          id={prefix + '-host-token'}
          type="text"
          class="pi-secret-token"
          bind:value={hostToken}
          disabled={busy}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
        />
        <label for={prefix + '-client-secret'}>{t('remoteSettings.clientSecret')}</label><input
          id={prefix + '-client-secret'}
          type="text"
          class="pi-secret-token"
          bind:value={clientSecret}
          disabled={busy}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
        />
        <label for={prefix + '-turn-secret'}>{t('remoteSettings.turnSecret')}</label><input
          id={prefix + '-turn-secret'}
          type="text"
          class="pi-secret-token"
          bind:value={turnSecret}
          disabled={busy}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
        />
      </details>
      <p>{t('remoteSettings.authHint')}</p>
      {#if error}<p class="remote-settings-error" role="alert">{error}</p>{/if}
      {#if saved}<p role="status">{t('remoteSettings.saved')}</p>{/if}
      <button type="submit" disabled={busy || !serverUrl || !room}
        >{t(busy ? 'remoteSettings.authenticating' : 'remoteSettings.save')}</button
      >
    </form>
  {/if}
  {#if showDevices}<button
      type="button"
      onclick={() => window.dispatchEvent(new Event('pi:devices'))}
      >{t('remoteSettings.devices')}</button
    >{/if}
</section>

<style>
  .remote-settings {
    padding: 18px;
    border: 1px solid var(--dim);
    border-radius: 14px;
    margin: 18px 0;
    color: var(--text);
    font-size: 12px;
  }
  h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 10px;
  }
  p {
    color: var(--text-soft);
    font-size: 12px;
    line-height: 1.8;
    margin: 9px 0;
  }
  label {
    display: block;
    margin: 14px 0 6px;
    font-size: 12px;
  }
  input,
  textarea {
    box-sizing: border-box;
    width: 100%;
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 8px;
    padding: 10px;
    font: inherit;
  }
  button {
    border: 1px solid var(--dim);
    border-radius: 8px;
    padding: 9px 12px;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    margin: 8px 0;
  }
  button[type='submit'] {
    background: var(--text);
    color: var(--body-bg);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  summary {
    cursor: pointer;
    padding: 12px 0;
    color: var(--text-soft);
  }
  details {
    border-bottom: 1px solid var(--dim);
    padding-bottom: 5px;
  }
  .remote-settings-error {
    color: var(--danger);
  }
</style>

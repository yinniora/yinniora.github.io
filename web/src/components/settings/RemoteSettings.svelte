<script>
  import { onMount } from 'svelte';
  import { getJSON, postJSON } from '../../shared/api.js';
  import { t } from '../../shared/i18n.js';
  import { icon, CircleHelp, Globe, Link2 } from '../../shared/icons.js';
  import RelaySetupGuide from './RelaySetupGuide.svelte';
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
  let activation = $state('');
  let showRelayGuide = $state(false);
  let privateSetupAvailable = $state(false);
  let privateConfigured = $state(false);
  let privateNetworkDetected = $state(false);
  let lanSetupAvailable = $state(false);
  let lanConfigured = $state(false);
  let consentUrl = $state('');
  let action = $state('');
  let sshDestination = $state('');
  let sshOrigin = $state('');
  let sshPort = $state(22);
  function apply(value) {
    serverUrl = value.serverUrl || '';
    room = value.room || '';
    hasSecrets = !!(value.hasHostToken && value.hasTurnSecret && value.hasClientSecret);
    privateSetupAvailable = !!value.privateSetupAvailable;
    privateConfigured = !!value.directConfigured;
    privateNetworkDetected = !!value.privateNetworkDetected;
    lanSetupAvailable = !!value.lanSetupAvailable;
    lanConfigured = !!value.lanConfigured;
    hostToken = '';
    turnSecret = '';
    clientSecret = '';
    configuration = '';
  }
  async function configure(request) {
    busy = true;
    error = '';
    saved = false;
    action = request.action || '';
    consentUrl = '';
    try {
      const data = await postJSON('/api/remote-settings', request);
      if (typeof data.consentUrl === 'string') {
        const link = new URL(data.consentUrl);
        if (link.origin === 'https://login.tailscale.com' && link.pathname.startsWith('/f/serve')) {
          consentUrl = link.href;
          return;
        }
      }
      if (!data.ok || !data.settings) throw new Error('configuration unavailable');
      apply(data.settings);
      activation = '';
      sshDestination = '';
      sshOrigin = '';
      saved = true;
      window.dispatchEvent(new Event('pi:remote-config-saved'));
    } catch (failure) {
      const message = failure.message || '';
      error = t(
        /(?:Mac|System) authentication/.test(message)
          ? 'remoteSettings.macAuthFailed'
          : message.includes('activation')
            ? 'remoteSettings.activationInvalid'
            : action === 'tailscale'
              ? 'remoteSettings.privateFailed'
              : action === 'ssh'
                ? 'remoteSettings.sshFailed'
                : action === 'lan'
                  ? 'remoteSettings.lanFailed'
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
  function deployRelay(event) {
    event.preventDefault();
    const [sshUser, sshHost, ...rest] = sshDestination.trim().split('@');
    if (!sshUser || !sshHost || rest.length) {
      error = t('remoteSettings.sshDestination');
      return;
    }
    void configure({ action: 'ssh', ssh: { sshUser, sshHost, sshPort, serverUrl: sshOrigin } });
  }
  function importActivation(event) {
    event.preventDefault();
    const input = activation.trim();
    if (input.startsWith('yugopi-relay:')) {
      void configure({ action: 'activate', setupCode: input });
      return;
    }
    try {
      const profile = JSON.parse(input);
      void configure({
        action: 'profile',
        serverUrl: profile.serverUrl,
        room: profile.room,
        hostToken: profile.hostToken,
        turnSecret: profile.turnSecret,
        clientSecret: profile.clientSecret,
      });
    } catch {
      error = t('remoteSettings.invalidImport');
    }
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
  function save(event) {
    event.preventDefault();
    void configure({ serverUrl, room, hostToken, turnSecret, clientSecret });
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

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<section class="remote-settings">
  <h3>{t('remoteSettings.title')}</h3>
  <p>{t('remoteSettings.intro')}</p>
  {#if loading}<p role="status">{t('remoteSettings.loading')}</p>
  {:else if !enabled}<p>{error || t('remoteSettings.setupRequired')}</p>
  {:else}
    {#if privateSetupAvailable}
      <div class="remote-setup-option">
        <div class="remote-setup-title">
          {@html icon(Globe, { size: 17 })}<strong>{t('remoteSettings.private')}</strong>
        </div>
        <p>
          {t(
            privateConfigured
              ? 'remoteSettings.privateReady'
              : privateNetworkDetected
                ? 'remoteSettings.privateDetected'
                : 'remoteSettings.privateHint',
          )}
        </p>
        <button type="button" disabled={busy} onclick={() => configure({ action: 'tailscale' })}>
          {t(
            busy && action === 'tailscale'
              ? 'remoteSettings.authenticating'
              : 'remoteSettings.enablePrivate',
          )}
        </button>
        {#if consentUrl}
          <p>{t('remoteSettings.privateConsent')}</p>
          <a href={consentUrl} target="_blank" rel="noreferrer"
            >{t('remoteSettings.openTailscale')}</a
          >
        {/if}
      </div>
    {/if}
    {#if lanSetupAvailable}
      <div class="remote-setup-option">
        <div class="remote-setup-title">
          {@html icon(Link2, { size: 17 })}<strong>{t('remoteSettings.lan')}</strong>
        </div>
        <p>{t(lanConfigured ? 'remoteSettings.lanReady' : 'remoteSettings.lanHint')}</p>
        {#if !lanConfigured}
          <button type="button" disabled={busy} onclick={() => configure({ action: 'lan' })}>
            {t(
              busy && action === 'lan'
                ? 'remoteSettings.authenticating'
                : 'remoteSettings.enableLAN',
            )}
          </button>
        {/if}
      </div>
    {/if}
    <div class="remote-setup-option">
      <div class="remote-setup-title">
        {@html icon(Link2, { size: 17 })}<strong>{t('remoteSettings.relaySetup')}</strong>
        <button
          type="button"
          class="remote-setup-help"
          aria-expanded={showRelayGuide}
          aria-controls={showRelayGuide ? prefix + '-relay-guide' : undefined}
          onclick={() => (showRelayGuide = !showRelayGuide)}
        >
          {@html icon(CircleHelp, { size: 16 })}{t('remoteSettings.relayGuide')}
        </button>
      </div>
      {#if showRelayGuide}<RelaySetupGuide id={prefix + '-relay-guide'} />{/if}
      {#if hasSecrets}<p>{t('remoteSettings.relayReady', { server: serverUrl })}</p>{/if}
      <form onsubmit={importActivation} autocomplete="off">
        <label for={prefix + '-activation'}>{t('remoteSettings.activation')}</label>
        <textarea
          id={prefix + '-activation'}
          class="pi-secret-token"
          bind:value={activation}
          rows="2"
          maxlength="8192"
          disabled={busy}
          spellcheck={false}
          autocapitalize="none"
        ></textarea>
        <button type="submit" disabled={busy || !activation.trim()}>
          {t(
            busy && (action === 'activate' || action === 'profile')
              ? 'remoteSettings.authenticating'
              : 'remoteSettings.linkRelay',
          )}
        </button>
      </form>
      <details>
        <summary>{t('remoteSettings.sshSetup')}</summary>
        <form onsubmit={deployRelay} autocomplete="off">
          <p>{t('remoteSettings.sshHint')}</p>
          <label for={prefix + '-ssh'}>{t('remoteSettings.sshDestination')}</label>
          <input
            id={prefix + '-ssh'}
            bind:value={sshDestination}
            placeholder="user@server.example.com"
            required
            disabled={busy}
            spellcheck={false}
          />
          <label for={prefix + '-ssh-port'}>{t('remoteSettings.sshPort')}</label>
          <input
            id={prefix + '-ssh-port'}
            type="number"
            min="1"
            max="65535"
            bind:value={sshPort}
            disabled={busy}
          />
          <label for={prefix + '-ssh-origin'}>{t('remoteSettings.sshOrigin')}</label>
          <input
            id={prefix + '-ssh-origin'}
            type="url"
            bind:value={sshOrigin}
            disabled={busy}
            placeholder="https://relay.example.com"
          />
          <button type="submit" disabled={busy || !sshDestination.trim()}>
            {t(
              busy && action === 'ssh' ? 'remoteSettings.sshDeploying' : 'remoteSettings.sshDeploy',
            )}
          </button>
        </form>
      </details>
    </div>
    <details class="remote-advanced">
      <summary>{t('remoteSettings.manual')}</summary>
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
        <button type="submit" disabled={busy || !serverUrl || !room}
          >{t(busy && !action ? 'remoteSettings.authenticating' : 'remoteSettings.save')}</button
        >
      </form>
    </details>
    {#if error}<p class="remote-settings-error" role="alert">{error}</p>{/if}
    {#if saved}<p role="status">{t('remoteSettings.saved')}</p>{/if}
  {/if}
  {#if showDevices}<button
      type="button"
      onclick={() => window.dispatchEvent(new Event('pi:devices'))}
      >{t('remoteSettings.devices')}</button
    >{/if}
</section>

<style>
  .remote-setup-option {
    display: grid;
    align-items: start;
    gap: 8px;
    margin-block: 12px;
    padding: 12px;
    border: 1px solid var(--dim);
    border-radius: 10px;
  }
  .remote-setup-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .remote-setup-title .remote-setup-help {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    margin: 0 0 0 auto;
    padding: 4px 8px;
    min-height: 32px;
    font-size: 12px;
    background: transparent;
    color: var(--text-soft);
    transition:
      background 150ms ease,
      color 150ms ease;
  }
  .remote-setup-title .remote-setup-help:hover,
  .remote-setup-title .remote-setup-help[aria-expanded='true'] {
    background: var(--surface-2);
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .remote-setup-title .remote-setup-help {
      transition: none;
    }
  }
  .remote-setup-option > p {
    margin: 0;
  }
  .remote-setup-option button {
    justify-self: start;
  }
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

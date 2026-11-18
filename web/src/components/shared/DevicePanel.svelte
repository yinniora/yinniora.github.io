<script>
  import RemoteSettings from '../settings/RemoteSettings.svelte';
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import { icon, Plus, Trash2, Link2 } from '../../shared/icons.js';
  import { t, getLocale } from '../../shared/i18n.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import FullScreenSheet from '../session/FullScreenSheet.svelte';

  let open = $state(false);
  let devices = $state([]);
  let canManage = $state(false);
  let canPair = $state(true);
  let enabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let name = $state('iPhone');
  let qr = $state('');
  let pairLink = $state('');
  let copied = $state(false);
  let expires = $state(0);
  let now = $state(Date.now());
  let confirmRevoke = $state('');
  let refreshVersion = 0;
  const remaining = $derived(Math.max(0, Math.ceil((expires - now) / 1000)));

  async function refresh() {
    const version = ++refreshVersion;
    const data = await getJSON('/api/devices');
    if (version !== refreshVersion) return;
    devices = (Array.isArray(data.devices) ? data.devices : []).filter(
      (device) => !device.revokedAt,
    );
    canManage = !!data.canManage;
    canPair = data.canPair !== false;
    enabled = !!data.enabled;
  }
  function dateLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t('devices.unknownTime');
    return new Intl.DateTimeFormat(getLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(date);
  }
  function featureLabel(device) {
    const { os, browser, app } = device.features || {};
    return (
      [os, browser, app ? t(`devices.${app === 'standalone' ? 'standalone' : 'browser'}`) : '']
        .filter(Boolean)
        .join(' · ') || t('devices.featuresPending')
    );
  }
  async function show() {
    open = true;
    error = '';
    qr = '';
    pairLink = '';
    copied = false;
    confirmRevoke = '';
    try {
      await refresh();
    } catch {
      error = t('devices.loadFailed');
    }
  }
  async function pair() {
    busy = true;
    error = '';
    qr = '';
    pairLink = '';
    copied = false;
    try {
      const data = await postJSON('/api/devices', { action: 'pair', name, qrVersion: 2 });
      pairLink = data.url;
      qr = await QRCode.toDataURL(data.url, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
      expires = Date.parse(data.expiresAt);
      now = Date.now();
    } catch {
      error = t('devices.macApprovalFailed');
    } finally {
      busy = false;
    }
  }
  async function revoke(id) {
    busy = true;
    error = '';
    refreshVersion++;
    try {
      await postJSON('/api/devices', { action: 'delete', id });
      devices = devices.filter((device) => device.id !== id);
      confirmRevoke = '';
      await refresh().catch(() => {
        error = t('devices.refreshFailed');
      });
    } catch {
      error = t('devices.removeFailed');
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    window.addEventListener('pi:devices', show);
    const configured = () => {
      if (open) refresh().catch(() => {});
    };
    window.addEventListener('pi:remote-config-saved', configured);
    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);
    const refreshTimer = setInterval(() => {
      if (open && canManage && !busy) refresh().catch(() => {});
    }, 5000);
    return () => {
      window.removeEventListener('pi:devices', show);
      window.removeEventListener('pi:remote-config-saved', configured);
      clearInterval(clock);
      clearInterval(refreshTimer);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<FullScreenSheet bind:open title={t('devices.title')} panelClass="device-sheet">
  <div class="device-panel">
    <div class="device-heading-icon">{@html icon(Link2, { size: 24 })}</div>
    <h2>{t('devices.headline')}</h2>
    <p class="device-intro">{t('devices.intro')}</p>
    {#if error}<p class="output-error" role="alert">{error}</p>{/if}
    {#if !enabled}<p class="device-notice">{t('devices.notEnabled')}</p>
    {:else if !canManage}<p class="device-notice">{t('devices.macOnly')}</p>
    {:else}
      <details class="device-server-settings">
        <summary>{t('remoteSettings.title')}</summary><RemoteSettings showDevices={false} />
      </details>
      <div class="device-pair-form">
        <label for="device-name">{t('devices.name')}</label>
        <div>
          <input id="device-name" bind:value={name} maxlength="100" /><button
            onclick={pair}
            disabled={busy || !canPair}
            >{@html icon(Plus, { size: 16 })}{busy
              ? t('devices.authenticating')
              : t('devices.createCode')}</button
          >
        </div>
        <p>{t(canPair ? 'devices.authHint' : 'remoteSettings.configureFirst')}</p>
      </div>
      {#if qr}
        <div class="device-qr">
          {#if remaining > 0}<img src={qr} alt={t('devices.qrAlt')} /><strong
              >{t('devices.scan')}</strong
            ><span>{t('devices.expires', { seconds: remaining })}</span>
            <p>{t('devices.appPairHint')}</p>
            <button
              type="button"
              onclick={async () => {
                copied = await copyToClipboard(pairLink);
              }}>{copied ? t('common.copied') : t('devices.copyPairLink')}</button
            >
          {:else}<p>{t('devices.expired')}</p>{/if}
        </div>
      {/if}
      <div class="device-list-heading">{t('devices.whitelist')}</div>
      {#if !devices.length}<p class="device-empty">{t('devices.empty')}</p>{/if}
      {#each devices as device (device.id)}
        <div class="device-row">
          <div class="device-details">
            <div class="device-row-heading">
              <strong>{device.name}</strong><span
                class:device-online={device.connected}
                class="device-presence"
                ><i aria-hidden="true"></i>{t(
                  device.connected ? 'devices.connected' : 'devices.offline',
                )}</span
              >
            </div>
            <span class="device-features">{featureLabel(device)}</span>
            <span
              >{t('devices.pairedAt')}
              <time datetime={device.createdAt}>{dateLabel(device.createdAt)}</time></span
            >
            <span
              >{t('devices.lastConnected')}
              <time datetime={device.lastSeen}>{dateLabel(device.lastSeen)}</time></span
            >
            <span class="device-short-id"
              >{t('devices.identifier')} <code>{String(device.id).slice(0, 12)}</code></span
            >
          </div>
          {#if confirmRevoke === device.id}<div class="device-remove-actions">
              <p>{t('devices.removeHint')}</p>
              <button
                class="device-revoke-confirm"
                disabled={busy}
                onclick={() => revoke(device.id)}
                >{busy ? t('devices.removing') : t('devices.confirmRemove')}</button
              ><button
                class="device-remove-cancel"
                disabled={busy}
                onclick={() => (confirmRevoke = '')}>{t('common.cancel')}</button
              >
            </div>
          {:else}<button
              class="device-revoke"
              title={t('devices.remove')}
              aria-label={`${t('devices.remove')} ${device.name} ${String(device.id).slice(0, 12)}`}
              disabled={busy}
              onclick={() => {
                confirmRevoke = device.id;
              }}>{@html icon(Trash2, { size: 16 })}</button
            >{/if}
        </div>
      {/each}
    {/if}
  </div>
</FullScreenSheet>

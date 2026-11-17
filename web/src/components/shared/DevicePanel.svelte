<script>
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import { icon, Plus, Trash2, Link2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { getJSON, postJSON } from '../../shared/api.js';
  import FullScreenSheet from '../session/FullScreenSheet.svelte';

  let open = $state(false);
  let devices = $state([]);
  let canManage = $state(false);
  let enabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let name = $state('iPhone');
  let qr = $state('');
  let expires = $state(0);
  let now = $state(Date.now());
  let confirmRevoke = $state('');
  const remaining = $derived(Math.max(0, Math.ceil((expires - now) / 1000)));

  async function refresh() {
    const data = await getJSON('/api/devices');
    devices = data.devices || [];
    canManage = !!data.canManage;
    enabled = !!data.enabled;
  }
  async function show() {
    open = true;
    error = '';
    qr = '';
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
    try {
      const data = await postJSON('/api/devices', { action: 'pair', name });
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
    try {
      await postJSON('/api/devices', { action: 'revoke', id });
      confirmRevoke = '';
      await refresh();
    } catch {
      error = t('devices.revokeFailed');
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    window.addEventListener('pi:devices', show);
    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);
    const refreshTimer = setInterval(() => {
      if (open && canManage && !busy) refresh().catch(() => {});
    }, 5000);
    return () => {
      window.removeEventListener('pi:devices', show);
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
      <div class="device-pair-form">
        <label for="device-name">{t('devices.name')}</label>
        <div>
          <input id="device-name" bind:value={name} maxlength="100" /><button
            onclick={pair}
            disabled={busy}
            >{@html icon(Plus, { size: 16 })}{busy
              ? t('devices.authenticating')
              : t('devices.createCode')}</button
          >
        </div>
        <p>{t('devices.authHint')}</p>
      </div>
      {#if qr}
        <div class="device-qr">
          {#if remaining > 0}<img src={qr} alt={t('devices.qrAlt')} /><strong
              >{t('devices.scan')}</strong
            ><span>{t('devices.expires', { seconds: remaining })}</span>
          {:else}<p>{t('devices.expired')}</p>{/if}
        </div>
      {/if}
      <div class="device-list-heading">{t('devices.whitelist')}</div>
      {#if !devices.length}<p class="device-empty">{t('devices.empty')}</p>{/if}
      {#each devices as device (device.id)}
        <div class="device-row" class:revoked={!!device.revokedAt}>
          <div>
            <strong>{device.name}</strong><span
              >{device.revokedAt ? t('devices.revoked') : t('devices.approved')} · {new Date(
                device.lastSeen,
              ).toLocaleDateString()}</span
            >
          </div>
          {#if !device.revokedAt}
            {#if confirmRevoke === device.id}<button
                class="device-revoke-confirm"
                disabled={busy}
                onclick={() => revoke(device.id)}>{t('devices.confirmRevoke')}</button
              >
            {:else}<button
                class="device-revoke"
                title={t('devices.revoke')}
                aria-label={`${t('devices.revoke')} ${device.name}`}
                onclick={() => {
                  confirmRevoke = device.id;
                }}>{@html icon(Trash2, { size: 16 })}</button
              >{/if}
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</FullScreenSheet>

<script>
  import { onMount } from 'svelte';
  import { getJSON } from '../../shared/api.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { t } from '../../shared/i18n.js';

  let { id } = $props();
  const releases = 'https://github.com/yinniora/yinniora.github.io/releases';
  const install = 'sudo python3 yugo-pi-relay-install.py';
  const renew = 'sudo yugo-pi-relay-setup --new-code';
  let download = $state('');
  let ready = $state(false);
  let copyStatus = $state('');
  const command = $derived(
    download ? `curl -fL '${download}' -o yugo-pi-relay-install.py &&\n${install}` : install,
  );

  onMount(async () => {
    try {
      const { current } = await getJSON('/api/version');
      if (typeof current === 'string' && /^\d+\.\d+\.\d+-yugo\.\d+$/.test(current)) {
        download = `${releases}/download/yugo-v${current}/yugo-pi-relay-install.py`;
      }
    } catch {
      // The release page can still be used to get the installer.
    } finally {
      ready = true;
    }
  });

  async function copyCommand() {
    copyStatus = (await copyToClipboard(command)) ? 'common.copied' : 'common.copyFailed';
  }
</script>

<section {id} class="relay-guide" aria-labelledby={id + '-heading'}>
  <h4 id={id + '-heading'}>{t('remoteSettings.relayGuideTitle')}</h4>
  <ol>
    <li>
      <strong>{t('remoteSettings.relayGuidePrepare')}</strong>
      <p>{t('remoteSettings.relayGuideServer')}</p>
      <p>
        {t('remoteSettings.relayGuidePorts', {
          web: 'TCP 80, 443',
          turn: 'TCP/UDP 3478',
          media: 'UDP 49160–49220',
        })}
      </p>
    </li>
    <li>
      <strong>{t('remoteSettings.relayGuideInstall')}</strong>
      <p>{t('remoteSettings.relayGuideRun')}</p>
      {#if ready}
        <pre><code>{command}</code></pre>
        <div class="guide-actions">
          <button type="button" onclick={copyCommand}>{t('remoteSettings.relayGuideCopy')}</button>
          <a href={download || releases} target="_blank" rel="noreferrer">
            {t(
              download ? 'remoteSettings.relayGuideDownload' : 'remoteSettings.relayGuideReleases',
            )}
          </a>
          {#if copyStatus}<span role="status">{t(copyStatus)}</span>{/if}
        </div>
      {/if}
    </li>
    <li>
      <strong>{t('remoteSettings.relayGuideActivate')}</strong>
      <p>{t('remoteSettings.relayGuideCode')}</p>
      <p>{t('remoteSettings.relayGuideExpired')} <code>{renew}</code></p>
    </li>
    <li>
      <strong>{t('remoteSettings.relayGuidePair')}</strong>
      <p>{t('remoteSettings.relayGuideScan')}</p>
    </li>
  </ol>
  <p class="ssh-hint">{t('remoteSettings.relayGuideSSH')}</p>
</section>

<style>
  .relay-guide {
    min-width: 0;
    padding: 14px;
    border: 1px solid var(--dim);
    border-radius: 10px;
    background: var(--surface-2);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.55;
    animation: guide-in 160ms ease-out both;
  }
  h4 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  ol {
    margin: 0;
    padding-inline-start: 1.45em;
  }
  li + li {
    margin-top: 12px;
  }
  li p {
    margin: 3px 0 0;
    color: var(--text-soft);
  }
  pre {
    margin: 8px 0 0;
    padding: 9px 10px;
    border: 1px solid var(--dim);
    border-radius: 8px;
    background: var(--input-bg);
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .guide-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 8px;
  }
  .guide-actions button {
    min-height: 32px;
    border: 1px solid var(--dim);
    border-radius: 7px;
    padding: 4px 8px;
    background: var(--surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .guide-actions a {
    color: var(--text);
    text-underline-offset: 3px;
  }
  .guide-actions span,
  .ssh-hint {
    color: var(--text-soft);
  }
  .ssh-hint {
    margin: 12px 0 0;
    padding-top: 9px;
    border-top: 1px solid var(--dim);
  }
  @keyframes guide-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .relay-guide {
      animation: none;
    }
  }
</style>

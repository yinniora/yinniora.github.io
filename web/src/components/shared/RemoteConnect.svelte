<script>
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { icon, Camera, Link2, X, Loader } from '../../shared/icons.js';
  import { parsePairingLink, normalizeTransport, TRANSPORT_KEY } from '../../remote/config.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { createCameraScanner } from '../../remote/camera-scanner.js';

  let {
    initialConfig = null,
    initialError = '',
    autoConnect = true,
    onConnect,
    mediaDevices = null,
  } = $props();
  let config = $state(untrack(() => initialConfig));
  let error = $state(untrack(() => initialError));
  let link = $state('');
  let busy = $state(false);
  let scanning = $state(false);
  let preference = $state('auto');
  let video = $state(null);
  let stream;
  let animation;
  let phase = $state('identity');
  let diagnostics = $state(null);
  let copied = $state(false);
  let scanGeneration = 0;

  function stopCamera() {
    scanGeneration++;
    globalThis.cancelAnimationFrame?.(animation);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;
    scanning = false;
  }

  async function connect(next = config) {
    if (!next || busy) return;
    stopCamera();
    config = next;
    busy = true;
    error = '';
    diagnostics = null;
    copied = false;
    try {
      try {
        localStorage.setItem(TRANSPORT_KEY, preference);
      } catch {}
      await onConnect(next, preference, (value) => (phase = value));
      link = '';
    } catch (failure) {
      diagnostics = failure.diagnostics || null;
      error =
        typeof failure.code === 'string'
          ? t(`remote.${failure.code}`)
          : failure.message || t('remote.failed');
    } finally {
      busy = false;
    }
  }

  function pasteConnect(event) {
    event.preventDefault();
    try {
      connect(parsePairingLink(link));
    } catch (failure) {
      error = t(`remote.${failure.code || 'invalidPairing'}`);
    }
  }

  async function startCamera() {
    stopCamera();
    error = '';
    scanning = true;
    const generation = scanGeneration;
    const scanner = createCameraScanner();
    try {
      const devices = mediaDevices || navigator.mediaDevices;
      if (!devices?.getUserMedia) throw new Error();
      await tick();
      const camera = await devices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (generation !== scanGeneration) {
        camera.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = camera;
      video.srcObject = camera;
      await video.play();
      const readFrame = await scanner;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      let last = 0;
      let frames = 0;
      const scan = async (time) => {
        if (generation !== scanGeneration) return;
        if (time - last >= 100 && video?.videoWidth) {
          last = time;
          const full = ++frames % 4 === 0;
          const side = Math.min(video.videoWidth, video.videoHeight);
          const width = full ? video.videoWidth : side,
            height = full ? video.videoHeight : side;
          const scale = Math.min(1, (full ? 960 : 720) / Math.max(width, height));
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          context.drawImage(
            video,
            (video.videoWidth - width) / 2,
            (video.videoHeight - height) / 2,
            width,
            height,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          let text = '';
          try {
            text = await readFrame(canvas, context, full);
          } catch {}
          if (generation !== scanGeneration) return;
          if (text) {
            try {
              const next = parsePairingLink(text);
              stopCamera();
              connect(next);
              return;
            } catch (failure) {
              error = t(`remote.${failure.code || 'invalidPairing'}`);
            }
          }
        }
        animation = requestAnimationFrame(scan);
      };
      animation = requestAnimationFrame(scan);
    } catch {
      if (generation === scanGeneration) {
        stopCamera();
        error = t('remote.cameraUnavailable');
      }
    }
  }

  onMount(() => {
    try {
      preference = normalizeTransport(localStorage.getItem(TRANSPORT_KEY));
    } catch {}
    const visibility = () => {
      if (document.hidden) stopCamera();
    };
    document.addEventListener('visibilitychange', visibility);
    if (config && autoConnect) connect();
    return () => document.removeEventListener('visibilitychange', visibility);
  });
  onDestroy(stopCamera);
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<section class="connect-card">
  <div class="connect-brand">
    {t('app.name')}
    <ConnectionStatus fallback={busy ? 'connecting' : 'unpaired'} />
  </div>
  <h1>{t('remote.welcome')}</h1>
  <p class="connect-intro">{t('remote.appHint')}</p>
  <fieldset disabled={busy} class="connect-routes">
    <legend>{t('remote.transport')}</legend>
    {#each ['auto', 'tailscale', 'vps'] as mode (mode)}
      <label class:selected={preference === mode}
        ><input type="radio" name="connection-route" value={mode} bind:group={preference} />{t(
          `remote.${mode}`,
        )}</label
      >
    {/each}
  </fieldset>
  <p class="connect-hint">{t(`remote.${preference}Hint`)}</p>
  {#if error}<p class="connect-error" role="alert">{error}</p>{/if}
  {#if diagnostics}<button
      type="button"
      class="connect-retry"
      onclick={async () => {
        copied = await copyToClipboard(JSON.stringify(diagnostics, null, 2));
      }}>{t(copied ? 'common.copied' : 'remote.copyDiagnostics')}</button
    >{/if}
  {#if busy}<div class="connect-progress" role="status">
      {@html icon(Loader, { size: 18 })}{t(`remote.phase.${phase}`)}
    </div>{/if}
  {#if scanning}
    <div class="connect-camera">
      <video bind:this={video} playsinline muted aria-label={t('remote.cameraHint')}></video>
      <p>{t('remote.cameraHint')}</p>
      <button type="button" onclick={stopCamera}
        >{@html icon(X, { size: 16 })}{t('remote.stopCamera')}</button
      >
    </div>
  {:else}
    <button type="button" class="connect-primary" disabled={busy} onclick={startCamera}
      >{@html icon(Camera, { size: 20 })}{t('remote.scan')}</button
    >
    <p class="connect-hint">{t('remote.scanInside')}</p>
  {/if}
  <form onsubmit={pasteConnect}>
    <label for="pi-pairing-link">{t('remote.pasteLabel')}</label>
    <textarea
      id="pi-pairing-link"
      rows="2"
      bind:value={link}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      placeholder={t('remote.pastePlaceholder')}
      disabled={busy}
    ></textarea>
    <button type="submit" class="connect-secondary" disabled={busy || !link.trim()}
      >{@html icon(Link2, { size: 17 })}{t('remote.connect')}</button
    >
  </form>
  {#if config}<button type="button" class="connect-retry" disabled={busy} onclick={() => connect()}
      >{t('remote.retry')}</button
    >{/if}
</section>

<style>
  .connect-card {
    width: min(100%, 410px);
    box-sizing: border-box;
    margin: 0 auto;
    text-align: left;
    color: var(--text, #242424);
    font:
      14px/1.6 -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
  }
  .connect-brand {
    font-size: 22px;
    font-weight: 650;
    margin-bottom: 24px;
    letter-spacing: -0.6px;
  }
  h1 {
    font-size: 26px !important;
    letter-spacing: -0.6px;
    margin: 0 0 10px;
    font-weight: 600;
  }
  .connect-intro,
  .connect-hint {
    color: var(--text-soft, #52525b);
    font-size: 13px;
    line-height: 1.7;
    margin: 8px 0 16px;
  }
  .connect-routes {
    display: flex;
    border: 0;
    padding: 0;
    margin: 22px 0 0;
    gap: 7px;
  }
  legend {
    font-size: 12px;
    color: var(--text-soft, #52525b);
    margin-bottom: 8px;
  }
  .connect-routes label {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    padding: 9px 7px;
    border: 1px solid var(--dim, #e4e4e7);
    border-radius: 9px;
    cursor: pointer;
  }
  .connect-routes input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .connect-routes label.selected {
    background: var(--surface-2, #f4f4f5);
    border-color: var(--text-soft, #52525b);
  }
  button {
    font: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    border-radius: 10px;
    min-height: 45px;
    padding: 10px 15px;
    box-sizing: border-box;
    width: 100%;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible,
  textarea:focus-visible,
  .connect-routes label:has(input:focus-visible) {
    outline: 2px solid #8499ca;
    outline-offset: 3px;
  }
  .connect-primary {
    background: var(--text, #242424);
    color: var(--body-bg, white);
    border: 1px solid var(--text, #242424);
    margin-top: 24px;
  }
  .connect-secondary {
    background: var(--surface, #fff);
    border: 1px solid var(--dim, #d4d4d8);
    color: var(--text, #242424);
    margin-top: 10px;
  }
  .connect-retry {
    border: 0;
    background: transparent;
    color: var(--text-soft, #52525b);
    margin-top: 9px;
  }
  form {
    margin-top: 26px;
    padding-top: 20px;
    border-top: 1px solid var(--dim, #e4e4e7);
  }
  form label {
    display: block;
    font-size: 12px;
    color: var(--text-soft, #52525b);
    margin-bottom: 7px;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--dim, #d4d4d8);
    border-radius: 9px;
    background: var(--surface, #fff);
    color: var(--text, #242424);
    padding: 12px;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    resize: vertical;
    min-height: 70px;
  }
  .connect-error {
    padding: 10px 12px;
    border-radius: 8px;
    background: #fef2f2;
    color: #a12b2b !important;
    font-size: 13px;
  }
  .connect-progress {
    display: flex;
    gap: 9px;
    align-items: center;
    color: var(--text-soft, #52525b);
    padding: 12px 0;
    font-size: 13px;
  }
  .connect-camera {
    border-radius: 12px;
    overflow: hidden;
    background: #171717;
    color: white;
    margin-top: 20px;
  }
  video {
    width: 100%;
    aspect-ratio: 4/3;
    object-fit: cover;
    display: block;
  }
  .connect-camera p {
    padding: 0 14px;
    color: #ddd !important;
    font-size: 12px;
  }
  .connect-camera button {
    background: #333;
    border: 0;
    color: white;
    border-radius: 0;
  }
</style>

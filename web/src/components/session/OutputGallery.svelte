<script>
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { icon, Download, ExternalLink, FileDiff, Maximize2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { showToast } from '../../shared/toast.js';
  import {
    assetUrl,
    collectOutputs,
    outputDocument,
    readPreviewText,
    svgPreviewURL,
    formatAssetSize,
    sessionOutputReferences,
  } from '../../session/artifacts/outputs.js';
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';

  let { model, sessionId = '', cwd = '', fetchImpl = null, children = null } = $props();
  let assets = $state([]);
  let assetsReady = $state(false);
  let assetRequest;
  let downloadScope;
  let previewRequest;
  let selected = $state(null);
  let previewOpen = $state(false);
  let previewText = $state('');
  let previewLoading = $state(false);
  let previewOrigin = $state('');
  let error = $state('');
  const failedVideos = new SvelteSet();
  const entries = $derived(model?.activePath || model?.entries || []);
  const references = $derived(sessionOutputReferences(entries, cwd));
  const outputs = $derived(collectOutputs(entries, assets, cwd, sessionId, references));
  const downloadBufferLimit = 16 * 1024 * 1024;
  const textPreviewLimit = 2 * 1024 * 1024;

  $effect(() => {
    if (!previewOpen) previewRequest?.abort();
  });

  async function refresh() {
    if (!sessionId) return;
    assetRequest?.abort();
    const request = new AbortController();
    assetRequest = request;
    try {
      const query = new SvelteURLSearchParams({ id: sessionId, scope: 'session' });
      for (const path of [...references.linked.keys()].slice(0, 40)) {
        if (query.toString().length > 4096) break;
        if (path.length <= 512) query.append('link', path);
      }
      const response = await (fetchImpl || fetch)(`/api/assets?${query}`, {
        signal: request.signal,
      });
      if (!response.ok) return;
      const data = await response.json();
      if (request.signal.aborted) return;
      const previousByPath = new Map(assets.map((asset) => [asset.path, asset]));
      assets = (Array.isArray(data.assets) ? data.assets : []).map((asset) => {
        const previous = previousByPath.get(asset.path);
        if (previous?.content && asset.modified && previous.modified === asset.modified)
          return { ...asset, content: previous.content };
        return asset;
      });
      assetsReady = true;
      await Promise.all(
        assets
          .filter((asset) => references.linked.has(asset.path))
          .filter((asset) => asset.kind === 'svg' && !asset.content && asset.size < 512 * 1024)
          .slice(0, 20)
          .map(async (asset) => {
            try {
              const response = await (fetchImpl || fetch)(
                `/api/asset?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(asset.path)}`,
                { signal: request.signal },
              );
              if (response.ok) asset.content = await readPreviewText(response, 512 * 1024);
            } catch {
              /* Keep the downloadable file even if its preview is unavailable. */
            }
          }),
      );
    } catch {
      // Transcript-backed previews remain available while reconnecting.
    } finally {
      if (!request.signal.aborted) assetsReady = true;
    }
  }

  async function open(output) {
    previewRequest?.abort();
    if (
      (output.kind === 'image' && output.previewUrl) ||
      (output.kind === 'svg' && output.content)
    ) {
      previewOpen = false;
      window.dispatchEvent(
        new CustomEvent('pi:image-preview', {
          detail: {
            src: output.kind === 'svg' ? svgPreviewURL(output.content) : output.previewUrl,
            alt: output.title,
          },
        }),
      );
      return;
    }
    selected = output;
    const recorded = output.recordedText
      ?.filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const snapshot = output.content ?? recorded;
    previewText = (snapshot ?? output.fallbackContent ?? '').slice(0, textPreviewLimit);
    previewOrigin = snapshot == null && previewText ? 'toolFiles.diff' : '';
    previewLoading = false;
    error = '';
    previewOpen = true;
    if (
      snapshot == null &&
      (output.kind === 'svg' ||
        output.readWorkspaceText ||
        /^(?:text\/|application\/json)/.test(output.mime || '')) &&
      output.href
    ) {
      const request = new AbortController();
      previewRequest = request;
      previewLoading = true;
      try {
        const response = await (fetchImpl || fetch)(output.href, { signal: request.signal });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !/^(?:text\/|application\/json|image\/svg\+xml)/i.test(type)) {
          await response.body?.cancel();
          throw new Error();
        }
        const text = await readPreviewText(response, textPreviewLimit);
        if (text == null) throw new Error();
        if (!request.signal.aborted) {
          previewText = text;
          previewOrigin = output.readWorkspaceText ? 'toolImages.workspaceFile' : '';
        }
      } catch {
        if (!request.signal.aborted && !previewText) error = t('outputs.previewUnavailable');
      } finally {
        if (!request.signal.aborted) previewLoading = false;
      }
    }
  }

  function saveFile(href, filename) {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  const notifyDownload = (key) =>
    showToast(t(key), { id: 'session-file-download', duration: 3500 });
  async function download(output) {
    const signal = downloadScope?.signal;
    try {
      let blob;
      if (output.href) {
        const method = output.size > downloadBufferLimit ? 'HEAD' : 'GET';
        const response = await (fetchImpl || fetch)(output.href, { method, signal });
        if ([400, 404, 410].includes(response.status)) {
          await response.body?.cancel();
          notifyDownload('outputs.fileUnavailable');
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('download failed');
        }
        if (
          method === 'HEAD' ||
          Number(response.headers.get('content-length')) > downloadBufferLimit
        ) {
          // Use the browser's streaming download for large files after the
          // host has confirmed the asset. Small downloads use the current
          // authenticated fetch so Safari never has to navigate to a file.
          await response.body?.cancel();
          if (!signal?.aborted) saveFile(output.href, output.title);
          return;
        }
        blob = await response.blob();
      } else {
        blob = new Blob([output.content || '']);
      }
      if (signal?.aborted) return;
      const url = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'));
      saveFile(url, output.title);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      if (!signal?.aborted) notifyDownload('outputs.downloadFailed');
    }
  }

  onMount(() => {
    downloadScope = new AbortController();
    const transcript = document.getElementById('messages');
    const onFileLink = (event) => {
      const link = event.target.closest?.('button[data-session-file]');
      if (!link) return;
      const path = link.dataset.sessionFile;
      if (!path || !sessionId) {
        notifyDownload('outputs.fileUnavailable');
        return;
      }
      const asset = assets.find((file) => file.path === path);
      void download({
        href: assetUrl(sessionId, path),
        title: link.dataset.filename,
        size: asset?.size,
      });
    };
    transcript?.addEventListener('click', onFileLink);
    let timer;
    const reload = ({ detail }) => {
      if (detail?.sessionId !== sessionId) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    refresh();
    window.addEventListener('pi-session-entries-reconciled', reload);
    return () => {
      downloadScope.abort();
      previewRequest?.abort();
      transcript?.removeEventListener('click', onFileLink);
      assetRequest?.abort();
      clearTimeout(timer);
      window.removeEventListener('pi-session-entries-reconciled', reload);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons and sanitized Markdown -->
{#snippet gallery(group, inlineMedia = true)}
  <section class="output-gallery" aria-label={t('outputs.title')}>
    <div class="output-grid">
      {#each group as output (output.id)}
        {@const hasImage =
          (output.kind === 'image' && output.previewUrl) ||
          (output.kind === 'svg' && output.content)}
        {@const hasPreview =
          hasImage ||
          (inlineMedia && output.previewUrl && ['video', 'audio'].includes(output.kind))}
        {@const fileType =
          output.title.match(/\.([\w-]+)$/)?.[1].toUpperCase() ||
          (output.kind === 'file' ? '' : output.kind.toUpperCase())}
        {@const fileMetadata = [fileType, formatAssetSize(output.size)].filter(Boolean).join(' · ')}
        {#snippet fileLabel()}
          <span class="output-file-name" title={output.filePath || output.title}
            >{output.title}</span
          >
          {#if fileMetadata}<span class="output-file-meta">{fileMetadata}</span>{/if}
        {/snippet}
        <article class="output-card" class:output-has-preview={hasPreview}>
          {#if hasImage}
            <button
              type="button"
              class="output-image-button"
              class:output-svg={output.kind === 'svg'}
              aria-label={`${t('media.enlarge')} ${output.title}`}
              onclick={() => open(output)}
            >
              <img
                class="output-inline-preview"
                src={output.kind === 'svg' ? svgPreviewURL(output.content) : output.previewUrl}
                alt=""
                loading="lazy"
                decoding="async"
              />
              <span class="output-image-zoom" aria-hidden="true"
                >{@html icon(Maximize2, { size: 16 })}</span
              >
            </button>
          {:else if inlineMedia && output.kind === 'video' && output.previewUrl}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              class="output-video"
              controls
              playsinline
              preload="metadata"
              src={output.previewUrl}
              onerror={() => failedVideos.add(output.id)}
            ></video>
            {#if failedVideos.has(output.id)}<p class="output-media-help">
                {t('media.videoUnsupported')}
              </p>{/if}
          {:else if inlineMedia && output.kind === 'audio' && output.previewUrl}
            <audio class="output-audio" controls preload="metadata" src={output.previewUrl}></audio>
          {/if}
          <div class="output-card-bar">
            {#if !hasPreview}
              <span class="output-file-icon" aria-hidden="true"
                >{@html icon(FileDiff, { size: 17 })}</span
              >
            {/if}
            {#if hasImage}
              <div class="output-file-details">{@render fileLabel()}</div>
            {:else}
              <button
                type="button"
                class="output-file-details output-file-open"
                aria-label={`${t('outputs.open')} ${output.title}`}
                onclick={() => open(output)}
              >
                <span class="output-file-label">{@render fileLabel()}</span>
                <span aria-hidden="true">{@html icon(ExternalLink, { size: 15 })}</span>
              </button>
            {/if}
            <div class="output-card-actions">
              {#if output.href || typeof output.content === 'string'}
                <button
                  type="button"
                  class="output-action output-download"
                  title={t('artifact.download')}
                  aria-label={`${t('artifact.download')} ${output.title}`}
                  onclick={() => download(output)}
                >
                  {@html icon(Download, { size: 16 })}<span>{t('artifact.download')}</span>
                </button>
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
  </section>
{/snippet}

{#if children}
  {@render children(outputs, gallery, assetsReady || !sessionId)}
{:else if outputs.length}
  {@render gallery(outputs)}
{/if}

<FullScreenSheet bind:open={previewOpen} title={selected?.title || t('outputs.title')}>
  {#if selected}
    <div class="output-full-view">
      <div class="output-full-toolbar">
        <span>{previewOrigin ? t(previewOrigin) : selected.title}</span>
        {#if selected.href || typeof selected.content === 'string'}
          <button onclick={() => download(selected)}
            >{@html icon(Download, { size: 16 })}{t('artifact.download')}</button
          >
        {/if}
      </div>
      {#if error}<p class="output-error">{error}</p>{/if}
      {#if selected.kind === 'svg' && previewText}
        <img class="output-full-image" src={svgPreviewURL(previewText)} alt={selected.title} />
      {:else if selected.kind === 'html'}
        <iframe
          class="output-full-frame"
          title={selected.title}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          srcdoc={outputDocument(previewText)}
        ></iframe>
      {:else if selected.kind === 'video' && selected.previewUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="output-full-video"
          controls
          playsinline
          preload="metadata"
          src={selected.previewUrl}
          onerror={() => (error = t('media.videoUnsupported'))}
        ></video>
      {:else if selected.kind === 'audio' && selected.previewUrl}
        <audio class="output-audio" controls src={selected.previewUrl}></audio>
      {:else if selected.kind === 'pdf' && selected.previewUrl}
        <iframe
          class="output-full-frame"
          title={selected.title}
          src={selected.previewUrl}
          sandbox=""
        ></iframe>
      {:else if selected.kind === 'markdown'}
        <div class="markdown-content">{@html safeMarkedParse(previewText, { marked })}</div>
      {:else if previewText}
        <pre class="output-source"><code>{previewText}</code></pre>
      {:else if previewLoading}
        <p class="output-file-help">{t('toolImages.loadingPreview')}</p>
      {:else}
        <p class="output-file-help">{t('outputs.downloadToOpen')}</p>
      {/if}
    </div>
  {/if}
</FullScreenSheet>

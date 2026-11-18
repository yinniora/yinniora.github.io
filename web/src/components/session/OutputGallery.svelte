<script>
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { icon, Download, ExternalLink, FileDiff, Play } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import {
    collectOutputs,
    outputDocument,
    svgPreviewURL,
    formatAssetSize,
  } from '../../session/artifacts/outputs.js';
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { SvelteSet } from 'svelte/reactivity';

  let { model, sessionId = '', cwd = '', fetchImpl = null, children = null } = $props();
  let assets = $state([]);
  let selected = $state(null);
  let previewOpen = $state(false);
  let previewText = $state('');
  let error = $state('');
  const failedVideos = new SvelteSet();
  const outputs = $derived(
    collectOutputs(model?.activePath || model?.entries, assets, cwd, sessionId),
  );

  async function refresh() {
    if (!sessionId) return;
    try {
      const response = await (fetchImpl || fetch)(
        `/api/assets?id=${encodeURIComponent(sessionId)}&scope=session`,
      );
      if (!response.ok) return;
      const data = await response.json();
      const next = Array.isArray(data.assets) ? data.assets : [];
      await Promise.all(
        next
          .filter((asset) => asset.kind === 'svg' && asset.size < 512 * 1024)
          .slice(0, 20)
          .map(async (asset) => {
            try {
              const response = await (fetchImpl || fetch)(
                `/api/asset?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(asset.path)}`,
              );
              if (
                response.ok &&
                Number(response.headers?.get?.('content-length') || 0) < 512 * 1024
              )
                asset.content = await response.text();
            } catch {
              /* Keep the downloadable file even if its preview is unavailable. */
            }
          }),
      );
      assets = next;
    } catch {
      // Transcript-backed previews remain available while reconnecting.
    }
  }

  async function open(output) {
    if (output.kind === 'image' || (output.kind === 'svg' && output.content)) {
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
    previewText = output.content || '';
    error = '';
    previewOpen = true;
    if (
      !previewText &&
      (output.kind === 'svg' || /^text\/|application\/json/.test(output.mime || '')) &&
      output.href
    ) {
      try {
        const response = await (fetchImpl || fetch)(output.href);
        if (!response.ok) throw new Error();
        const length = Number(response.headers?.get?.('content-length') || 0);
        if (length > 2 * 1024 * 1024) return;
        previewText = (await response.text()).slice(0, 2 * 1024 * 1024);
      } catch {
        error = t('outputs.previewUnavailable');
      }
    }
  }

  function download(output) {
    if (output.href) {
      const anchor = document.createElement('a');
      anchor.href = output.href;
      anchor.download = output.title;
      anchor.click();
      return;
    }
    const url = URL.createObjectURL(
      new Blob([output.content || ''], { type: 'application/octet-stream' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = output.title;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onMount(() => {
    let timer;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    refresh();
    window.addEventListener('pi-session-reload', reload);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pi-session-reload', reload);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons and sanitized Markdown -->
{#snippet gallery(group)}
  <section class="output-gallery" aria-label={t('outputs.title')}>
    <div class="output-section-title">{t('outputs.title')}<span>{group.length}</span></div>
    <div class="output-grid">
      {#each group as output (output.id)}
        <article
          class="output-card"
          class:output-visual={['svg', 'image', 'video'].includes(output.kind)}
        >
          <div class="output-card-header">
            <span class="output-file-icon" aria-hidden="true"
              >{@html icon(output.kind === 'video' ? Play : FileDiff, { size: 17 })}</span
            >
            <span class="output-file-name" title={output.filePath || output.title}
              >{output.title}</span
            >
            <span class="output-file-size">{formatAssetSize(output.size)}</span>
            <button
              class="output-icon-button"
              title={t('artifact.download')}
              aria-label={`${t('artifact.download')} ${output.title}`}
              onclick={() => download(output)}>{@html icon(Download, { size: 16 })}</button
            >
          </div>
          {#if output.kind === 'svg' && output.content}
            <button
              class="output-image-button"
              aria-label={`${t('media.enlarge')} ${output.title}`}
              onclick={() => open(output)}
            >
              <img
                class="output-inline-preview"
                src={svgPreviewURL(output.content)}
                alt={output.title}
                loading="lazy"
              />
            </button>
          {:else if output.kind === 'image'}
            <button
              class="output-image-button"
              onclick={() => open(output)}
              aria-label={`${t('artifact.preview')} ${output.title}`}
              ><img src={output.previewUrl} alt={output.title} loading="lazy" /></button
            >
          {:else if output.kind === 'video'}
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
                {t('media.videoUnsupported')}<button onclick={() => download(output)}
                  >{t('artifact.download')}</button
                >
              </p>{/if}
          {:else if output.kind === 'audio'}
            <audio class="output-audio" controls preload="metadata" src={output.previewUrl}></audio>
          {/if}
          <div class="output-card-footer">
            <span>{output.kind.toUpperCase()}</span>
            <button onclick={() => open(output)}
              >{@html icon(ExternalLink, { size: 14 })}{t('outputs.open')}</button
            >
          </div>
        </article>
      {/each}
    </div>
  </section>
{/snippet}

{#if children}
  {@render children(outputs, gallery)}
{:else if outputs.length}
  {@render gallery(outputs)}
{/if}

<FullScreenSheet bind:open={previewOpen} title={selected?.title || t('outputs.title')}>
  {#if selected}
    <div class="output-full-view">
      <div class="output-full-toolbar">
        <span>{selected.title}</span><button onclick={() => download(selected)}
          >{@html icon(Download, { size: 16 })}{t('artifact.download')}</button
        >
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
      {:else if selected.kind === 'image'}
        <img class="output-full-image" src={selected.previewUrl} alt={selected.title} />
      {:else if selected.kind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="output-full-video"
          controls
          playsinline
          preload="metadata"
          src={selected.previewUrl}
          onerror={() => (error = t('media.videoUnsupported'))}
        ></video>
      {:else if selected.kind === 'audio'}
        <audio class="output-audio" controls src={selected.previewUrl}></audio>
      {:else if selected.kind === 'pdf'}
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
      {:else}
        <p class="output-file-help">{t('outputs.downloadToOpen')}</p>
      {/if}
    </div>
  {/if}
</FullScreenSheet>

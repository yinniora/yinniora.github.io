<script>
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { svgPreviewURL } from '../../session/artifacts/outputs.js';
  import { icon, Image, Maximize2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let { images } = $props();
  const svgPreviews = new SvelteMap();
  const failed = new SvelteSet();
  const maxSvgBytes = 2 * 1024 * 1024;

  function loadSVG(node, { id, svgHref }) {
    if (!svgHref || svgPreviews.has(id)) return;
    const request = new AbortController();
    async function load() {
      try {
        const response = await fetch(svgHref, { signal: request.signal });
        if (
          !response.ok ||
          !response.headers.get('content-type')?.startsWith('image/svg+xml') ||
          Number(response.headers.get('content-length')) > maxSvgBytes
        ) {
          await response.body?.cancel();
          throw new Error('preview unavailable');
        }
        const svg = await response.text();
        if (svg.length > maxSvgBytes) throw new Error('preview too large');
        if (!request.signal.aborted) svgPreviews.set(id, svgPreviewURL(svg));
      } catch {
        if (!request.signal.aborted) failed.add(id);
      }
    }
    let observer;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          void load();
        },
        { rootMargin: '120px' },
      );
      observer.observe(node);
    } else {
      void load();
    }
    return {
      destroy() {
        observer?.disconnect();
        request.abort();
      },
    };
  }

  function open(src, alt) {
    window.dispatchEvent(new CustomEvent('pi:image-preview', { detail: { src, alt } }));
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<section class="tool-image-strip" aria-label={t('toolImages.title')}>
  <div class="output-section-title">{t('toolImages.title')}</div>
  <div class="tool-image-grid">
    {#each images as image (image.id)}
      {@const title = image.title || t('media.image')}
      {@const src = image.src || svgPreviews.get(image.id)}
      {@const unavailable = failed.has(image.id) || (!src && !image.svgHref)}
      <figure class="tool-preview">
        <button
          type="button"
          class="tool-preview-thumb"
          class:tool-preview-svg={src?.startsWith('data:image/svg+xml') && !unavailable}
          use:loadSVG={image}
          disabled={!src || unavailable}
          aria-label={`${t('media.enlarge')} ${title}`}
          onclick={() => open(src, title)}
        >
          {#if src && !unavailable}
            <img
              {src}
              alt=""
              loading="lazy"
              decoding="async"
              onerror={() => failed.add(image.id)}
            />
            <span class="tool-preview-zoom" aria-hidden="true"
              >{@html icon(Maximize2, { size: 13 })}</span
            >
          {:else}
            <span aria-hidden="true">{@html icon(Image, { size: 19 })}</span>
            <span class="tool-preview-status">
              {t(unavailable ? 'toolImages.previewUnavailable' : 'toolImages.loadingPreview')}
            </span>
          {/if}
        </button>
        <figcaption {title}>{title}</figcaption>
      </figure>
    {/each}
  </div>
</section>

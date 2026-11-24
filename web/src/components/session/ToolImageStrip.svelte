<script>
  import { SvelteMap } from 'svelte/reactivity';
  import { resolveToolImage } from '../../session/artifacts/tool-files.js';
  import { icon, Image, Maximize2 } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let { images, workspacePreviews } = $props();
  const sources = new SvelteMap();
  const pending = new WeakMap();
  let observer;

  function loadPreview(node, image) {
    const request = new AbortController();
    async function load() {
      let source = null;
      try {
        source = await resolveToolImage(image, request.signal, workspacePreviews);
      } catch {
        // A missing workspace file or interrupted fetch leaves the label visible.
      }
      if (!request.signal.aborted) sources.set(image.id, source);
    }
    if (typeof IntersectionObserver === 'function') {
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            void pending.get(entry.target)?.();
            pending.delete(entry.target);
          }
        },
        { rootMargin: '120px' },
      );
      pending.set(node, load);
      observer.observe(node);
    } else {
      void load();
    }
    return {
      destroy() {
        observer?.unobserve(node);
        pending.delete(node);
        request.abort();
        sources.delete(image.id);
      },
    };
  }

  function open(src, alt) {
    window.dispatchEvent(new CustomEvent('pi:image-preview', { detail: { src, alt } }));
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons -->
<div class="tool-image-grid">
  {#each images as image (image.id)}
    {@const title = image.title || t('media.image')}
    {@const source = sources.get(image.id)}
    <figure class="tool-preview">
      <button
        type="button"
        class="tool-preview-thumb"
        class:tool-preview-svg={source?.url.startsWith('data:image/svg+xml')}
        use:loadPreview={image}
        disabled={!source}
        aria-label={`${t('media.enlarge')} ${title}`}
        onclick={() => open(source.url, title)}
      >
        {#if source}
          <img
            src={source.url}
            alt=""
            loading="lazy"
            decoding="async"
            fetchpriority="low"
            onerror={() => sources.set(image.id, null)}
          />
          <span class="tool-preview-zoom" aria-hidden="true"
            >{@html icon(Maximize2, { size: 13 })}</span
          >
        {:else}
          <span aria-hidden="true">{@html icon(Image, { size: 19 })}</span>
          <span class="tool-preview-status">
            {t(source === null ? 'toolImages.previewUnavailable' : 'toolImages.loadingPreview')}
          </span>
        {/if}
      </button>
      <figcaption {title}>
        <span class="tool-preview-name">{title}</span>
        {#if source?.workspace}<span class="tool-preview-origin"
            >{t('toolImages.workspaceFile')}</span
          >{/if}
      </figcaption>
    </figure>
  {/each}
</div>

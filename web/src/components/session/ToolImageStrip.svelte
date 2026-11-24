<script>
  import { SvelteMap } from 'svelte/reactivity';
  import { resolveToolImage } from '../../session/artifacts/tool-images.js';
  import { icon, Image, Maximize2, Pencil, Wrench } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let { group, workspacePreviews } = $props();
  const glyphs = { view: Image, edit: Pencil, other: Wrench };
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
<section
  class="tool-image-strip"
  class:tool-image-reference={group.summarized}
  aria-label={t('toolImages.' + group.action)}
>
  <div class="tool-image-label">
    <span aria-hidden="true">{@html icon(glyphs[group.action], { size: 14 })}</span>
    <span>{t('toolImages.' + group.action)}</span>
    {#if group.action === 'other' && group.tool}
      <span class="tool-image-operation" title={group.tool}>{group.tool.split('__').at(-1)}</span>
    {/if}
    {#if group.summarized}
      {@const filenames = group.images.map((image) => image.title || t('media.image')).join(' · ')}
      <span class="tool-image-operation" title={filenames}>{filenames}</span>
    {/if}
  </div>
  {#if !group.summarized}
    <div class="tool-image-grid">
      {#each group.images as image (image.id)}
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
          <figcaption {title}>{title}</figcaption>
          {#if source?.workspace}<span class="tool-preview-origin"
              >{t('toolImages.workspaceFile')}</span
            >{/if}
        </figure>
      {/each}
    </div>
  {/if}
</section>

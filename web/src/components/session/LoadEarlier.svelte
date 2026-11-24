<script>
  import { t } from '../../shared/i18n.js';
  import { onDestroy } from 'svelte';
  import { sessionWindowURL } from '../../session/data/session-sync.js';

  let {
    model,
    sessionId = '',
    fetchImpl = null,
    navigateTo = null,
    windowSize = 500,
    onHistoryChanged = null,
  } = $props();

  let loading = $state(false);
  let error = $state('');
  const scope = new AbortController();
  onDestroy(() => scope.abort());

  const shown = $derived(model?.entries?.length || 0);
  const total = $derived(model?.total || shown);
  const remaining = $derived(Math.max(0, model?.from || 0));
  const nextCount = $derived(Math.min(windowSize, remaining));
  const visible = $derived(!!model && !!model.truncated && remaining > 0);
  const effectiveFetch = $derived(
    fetchImpl || (typeof window !== 'undefined' ? window.fetch.bind(window) : null),
  );

  async function loadEarlier() {
    if (loading || !visible || !effectiveFetch) return;
    const requestFrom = Math.max(0, model.from - windowSize);
    const requestCount = model.from - requestFrom;
    const end = model.from;
    const revision = model.revision;
    const anchorId = model.entries[0]?.id || null;
    loading = true;
    error = '';
    try {
      const url = sessionWindowURL(sessionId, {
        model,
        range: { from: requestFrom, count: requestCount },
      });
      const res = await effectiveFetch(url, { signal: scope.signal });
      if (res.status === 409) {
        onHistoryChanged?.();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (
        scope.signal.aborted ||
        end !== model.from ||
        (model.revision !== revision && model.revision !== payload.revision)
      )
        return;
      const earlier = Array.isArray(payload?.entries) ? payload.entries : [];
      const from = Number.isInteger(payload.from) ? payload.from : requestFrom;
      if (payload.sessionId && payload.sessionId !== sessionId) return;
      if (from < requestFrom || from + earlier.length !== end || !earlier.length) {
        onHistoryChanged?.();
        return;
      }
      model.reconcile?.([...earlier, ...model.entries]);
      navigateTo?.(model.leafId, anchorId ? 'target' : 'bottom', anchorId || null);
      model.from = from;
      model.truncated = model.from > 0;
    } catch (err) {
      if (!scope.signal.aborted) error = err?.message || String(err);
    } finally {
      loading = false;
    }
  }
</script>

{#if visible}
  <div
    id="load-earlier-banner"
    class="load-earlier-banner"
    role="region"
    aria-label={t('session.earlierMessages')}
  >
    <span class="load-earlier-label"
      >{t('session.showingLatestMessages', {
        shown: shown.toLocaleString(),
        total: total.toLocaleString(),
      })}</span
    >
    <button
      type="button"
      class="load-earlier-button"
      disabled={loading || remaining <= 0}
      onclick={loadEarlier}
    >
      {#if loading}{t('session.loadingEarlier')}{:else}{t('session.loadEarlierCount', {
          count: nextCount.toLocaleString(),
        })}{/if}
    </button>
    <span class="load-earlier-status"
      >{#if error}{t('session.loadEarlierFailed', { error })}{/if}</span
    >
  </div>
{/if}

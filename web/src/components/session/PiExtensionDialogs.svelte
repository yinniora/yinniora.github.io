<script>
  import { SvelteSet } from 'svelte/reactivity';
  import { onMount } from 'svelte';
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { postJSON } from '../../shared/api.js';
  import { showToast } from '../../shared/toast.js';
  import { t } from '../../shared/i18n.js';

  let { sessionId } = $props();
  let dialogs = $state([]),
    activeId = $state(''),
    value = $state('');
  let pendingId = $state(''),
    error = $state('');
  const answered = new SvelteSet();
  const notices = new SvelteSet();
  let hydrated = false;
  const fieldName = $props.id();
  const active = $derived(
    dialogs.find((dialog) => dialog.id === activeId && !answered.has(dialog.id)) ||
      dialogs.find((dialog) => !answered.has(dialog.id)),
  );

  $effect(() => {
    if (active?.id !== activeId) {
      activeId = active?.id || '';
      value = active?.prefill || '';
      error = '';
    }
  });

  function update(event) {
    if (event.detail?.sessionId !== sessionId) return;
    const next = event.detail.ui;
    dialogs = next?.dialogs || [];
    for (const id of answered) {
      if (!dialogs.some((dialog) => dialog.id === id)) answered.delete(id);
    }
    const latest = (next?.notices || []).filter((notice) => !notices.has(notice.id));
    if (hydrated && latest.length) showToast(latest.at(-1).message, { id: 'pi-extension-notice' });
    notices.clear();
    for (const notice of next?.notices || []) notices.add(notice.id);
    hydrated = true;
  }

  async function reply(answer) {
    const id = active?.id;
    if (!id || pendingId) return;
    pendingId = id;
    error = '';
    try {
      await postJSON('/api/extension-ui?id=' + encodeURIComponent(sessionId), { id, ...answer });
      answered.add(id);
    } catch (failure) {
      if (failure.message === 'Pi extension request expired') {
        answered.add(id);
        showToast(t('piExtension.expired'), { id: 'pi-extension-notice' });
      } else if (active?.id === id) error = t('piExtension.answerFailed');
    } finally {
      pendingId = '';
    }
  }
  onMount(() => {
    window.addEventListener('pi:extension-ui', update);
    return () => window.removeEventListener('pi:extension-ui', update);
  });
</script>

<FullScreenSheet
  open={!!active}
  title={t('piExtension.title')}
  showBack={false}
  showClose={false}
  closeOnBackdrop={false}
  closeOnEscape={false}
>
  {#if active}
    <div class="extension-dialog">
      <h3>{active.title || t('piExtension.title')}</h3>
      {#if active.message}<p>{active.message}</p>{/if}
      {#if error}<p class="extension-error" role="alert">{error}</p>{/if}
      {#if active.method === 'select'}
        <div class="extension-choices">
          {#each active.options || [] as option, index (index)}
            <button
              type="button"
              class="btn-secondary"
              disabled={!!pendingId}
              onclick={() => reply({ value: option })}>{option}</button
            >
          {/each}
        </div>
      {/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          if (active.method === 'confirm') reply({ confirmed: true });
          if (active.method === 'input' || active.method === 'editor') reply({ value });
        }}
      >
        {#if active.method === 'input' || active.method === 'editor'}
          <label for={fieldName}>{t('piExtension.response')}</label>
          {#if active.method === 'editor'}
            <textarea id={fieldName} rows="5" bind:value maxlength="16000" disabled={!!pendingId}
            ></textarea>
          {:else}
            <input
              id={fieldName}
              type="text"
              bind:value
              placeholder={active.placeholder || ''}
              maxlength="16000"
              disabled={!!pendingId}
            />
          {/if}
        {/if}
        <div class="extension-actions">
          <button
            type="button"
            class="btn-secondary"
            disabled={!!pendingId}
            onclick={() =>
              reply(active.method === 'confirm' ? { confirmed: false } : { cancelled: true })}
            >{t('common.cancel')}</button
          >
          {#if active.method !== 'select'}<button
              type="submit"
              class="btn-primary"
              disabled={!!pendingId}
            >
              {t(active.method === 'confirm' ? 'piExtension.confirm' : 'composer.send')}
            </button>{/if}
        </div>
      </form>
    </div>
  {/if}
</FullScreenSheet>

<style>
  .extension-dialog,
  form,
  .extension-choices {
    display: grid;
    gap: 10px;
    min-width: 0;
  }
  .extension-dialog h3 {
    font-size: 16px;
    margin: 0;
  }
  .extension-dialog p {
    color: var(--text-soft);
    margin: 0;
    line-height: 1.6;
    white-space: pre-wrap;
  }
  .extension-dialog :is(h3, p, button) {
    overflow-wrap: anywhere;
  }
  .extension-dialog .extension-error {
    color: var(--danger);
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--workspace-edge);
    border-radius: 8px;
    font-size: 16px;
  }
  button {
    min-height: 42px;
  }
  .extension-choices button {
    text-align: left;
  }
  .extension-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>

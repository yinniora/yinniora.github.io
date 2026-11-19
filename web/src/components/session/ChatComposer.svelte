<script module>
  import { t } from '../../shared/i18n.js';
  import { runChatComposer } from './chat/chat-composer-runtime.js';
  // runChatComposer is the live-only DOM/runtime glue (used by onMount below).
  // Re-exported so existing imports and tests can reach it via this module.
  // eslint-disable-next-line no-import-assign -- re-export of an imported binding; false positive across module/instance scripts
  export { runChatComposer };
</script>

<script>
  import { onMount, untrack } from 'svelte';
  import { escapeHtml } from '../../session/render/session-format.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import * as chatApi from '../../session/chat/chat-api.js';
  import GitFooter from './GitFooter.svelte';
  import ChatExpandButton from './chat/ChatExpandButton.svelte';
  import ChatSelectorPopups from './chat/ChatSelectorPopups.svelte';
  import ChatToolbar from './chat/ChatToolbar.svelte';
  import ContextUsage from './chat/ContextUsage.svelte';
  import QueuePanel from './chat/QueuePanel.svelte';
  import TextAttachmentModal from './chat/TextAttachmentModal.svelte';
  import { ChatToolbarState } from './chat/chat-toolbar-state.svelte.js';
  import { QueueStore } from './chat/queue-store.svelte.js';
  import { createQueueApi } from './chat/queue-api.js';
  import { progressLabel } from '../../session/live/chat-preview.js';

  let {
    sessionId = '',
    chatAvailable = true,
    sessionRunning = false,
    chatDisabledReason = '',
    cwd = '',
    modelLabel = '',
  } = $props();

  // Reactive toolbar state owned here so the live runtime can mutate it while
  // <ChatToolbar> renders from it.
  const toolbar = new ChatToolbarState();
  let previewPhase = $state('');
  let toolProgress = $state(null);
  let toolSeconds = $state(0);
  const toolDuration = $derived(
    `${Math.floor(toolSeconds / 60)}:${String(toolSeconds % 60).padStart(2, '0')}`,
  );

  $effect(() => {
    const tool = toolProgress;
    if (!tool) return;
    const tick = () => {
      toolSeconds = Math.floor((tool.elapsed + performance.now() - tool.observedAt) / 1000);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });
  // Reactive queue panel state — shared with chat-composer-runtime so its
  // steer/queue glue mutates the same items <QueuePanel> renders. The queued
  // items live on the server (chat_queue table); we hydrate on mount and
  // re-fetch on SSE 'queue' events so other tabs (and the autonomous
  // backend drainer) stay in sync.
  const queueApi = untrack(() =>
    sessionId
      ? createQueueApi({
          sessionId,
          fetchImpl: typeof window !== 'undefined' ? window.fetch.bind(window) : undefined,
        })
      : null,
  );
  const queueStore = new QueueStore({ api: queueApi });

  // The composer runtime lives in <script module> (runChatComposer). It reads the
  // shared model + navigateTo (owned by SessionPage runtime context) at mount —
  // both are ready before this onMount. <LiveReload> mounts first, so its
  // pi-chat-message-sent listener is attached before the user can send. Live-only.
  onMount(() => {
    const target = window;
    const runtime = getSessionRuntime();
    const model = runtime.model;
    globalThis.__PI_TEST_CHAT_COMPOSER_HOOK__?.();
    const disposeComposer = runChatComposer({
      documentImpl: document,
      windowImpl: target,
      locationImpl: target.location,
      localEntries: model?.entries || [],
      leafId: model?.leafId || '',
      urlTargetId: model?.urlTargetId || '',
      byId: model?.byId || new Map(),
      // Live getter: steer-queue uses this on every pi-session-reload to look
      // for a matching user entry and clear the corresponding steer chip once
      // pi has folded the steer into the conversation.
      getLiveEntries: () => (model ? model.entries : []),
      navigateTo: runtime.navigateTo,
      escapeHtml: (text) => escapeHtml(text, { documentImpl: document }),
      chatApi,
      FormDataImpl: target.FormData,
      URLSearchParamsImpl: target.URLSearchParams,
      CustomEventImpl: target.CustomEvent,
      setIntervalImpl: target.setInterval.bind(target),
      toolbar,
      queueStore,
      queueApi,
    });

    // Initial hydration from the server-side queue + subscribe to SSE 'queue'
    // events so changes from the autonomous drainer (or another tab) show up
    // immediately. The EventSource is shared with <LiveReload> — both attach
    // their own listeners.
    void queueStore.refresh?.();
    try {
      const key = `pi-personal:draft:${sessionId}`;
      const draft = target.sessionStorage.getItem(key);
      const input = document.getElementById('pi-chat-message');
      if (draft && input) {
        input.value = draft;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        target.sessionStorage.removeItem(key);
      }
    } catch {
      /* Draft recovery is optional when browser storage is unavailable. */
    }
    const onQueueEvent = () => queueStore.refresh?.();
    const onChatPhase = (event) => {
      if (event.detail?.sessionId !== sessionId) return;
      const { phase, toolName, toolElapsedMs } = event.detail;
      previewPhase = phase;
      toolProgress =
        phase === 'tool' && typeof toolName === 'string' && toolName
          ? {
              name: toolName,
              elapsed: Math.max(0, Number(toolElapsedMs) || 0),
              observedAt: performance.now(),
            }
          : null;
    };
    target.addEventListener('pi-queue-event', onQueueEvent);
    target.addEventListener('pi:chat-phase', onChatPhase);
    return () => {
      disposeComposer();
      target.removeEventListener('pi-queue-event', onQueueEvent);
      target.removeEventListener('pi:chat-phase', onChatPhase);
    };
  });
</script>

<form
  id="pi-chat-composer"
  class="pi-chat-composer"
  data-session-id={sessionId}
  data-chat-available={chatAvailable}
  data-chat-disabled-reason={chatDisabledReason}
>
  <input
    id="pi-chat-images"
    name="images"
    type="file"
    accept="image/*"
    multiple
    hidden
    disabled={!chatAvailable}
  />
  <input
    id="pi-chat-camera"
    type="file"
    accept="image/*"
    capture="environment"
    hidden
    disabled={!chatAvailable}
  />
  <input id="pi-chat-files" type="file" multiple hidden disabled={!chatAvailable} />
  <QueuePanel store={queueStore} />
  <!-- The transcript's live preview owns detailed progress (phase, tool, elapsed).
       This line only covers states the transcript cannot show: compaction and a
       run started elsewhere before any preview arrived. -->
  {#if toolbar.compacting || (!previewPhase && (toolbar.isRunning || (!chatAvailable && sessionRunning)))}
    <div class="session-progress" role="status">
      <span class="session-progress-spinner" aria-hidden="true"></span>
      <span>{toolbar.compacting ? t('piSession.compacting') : progressLabel(previewPhase)}</span>
      {#if toolProgress && !toolbar.compacting}
        <span class="session-progress-tool">{toolProgress.name}</span>
        <span class="session-progress-duration" aria-hidden="true">{toolDuration}</span>
      {/if}
    </div>
  {/if}
  <div class="pi-chat-shell">
    <ChatExpandButton {chatAvailable} />
    {#if cwd}<div class="pi-chat-toolbar pi-chat-cwd-bar">
        <span class="pi-chat-cwd" title={t('composer.copyPath')} data-cwd={cwd}>cwd: {cwd}</span
        ><span class="pi-chat-focus-shortcut">{t('composer.focusShortcut')}</span>
      </div>{/if}
    {#if !chatAvailable}<div class="pi-chat-disabled-notice">{chatDisabledReason}</div>{/if}
    <div id="pi-chat-attachments" class="pi-chat-attachments"></div>
    <textarea
      id="pi-chat-message"
      name="message"
      rows="1"
      placeholder={t('composer.placeholder')}
      disabled={!chatAvailable}
    ></textarea>
    <ChatSelectorPopups />
    <ChatToolbar {chatAvailable} {toolbar} {modelLabel} {sessionId} />
    <ContextUsage popover />
  </div>
  <TextAttachmentModal />
  <GitFooter {sessionId} />
</form>

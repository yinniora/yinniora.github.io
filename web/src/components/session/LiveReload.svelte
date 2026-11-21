<script>
  // Live reload (SSE) — drives the streaming chat preview, follow/scroll, stats,
  // and reconciles the shared reactive model when the session JSONL changes. The
  // Svelte <SessionContent> owns #messages and re-renders from the model, so this
  // never patches the message DOM (reactive-only): on reload it reconciles the
  // model through the session runtime context and only tracks brand-new ids for the
  // follow/scroll/highlight decisions. Live-only: never imported by the static
  // export bundle.
  //
  // The old live-reload runner has been split between this component and focused
  // live-only helpers in session/live/: connection/reconnect lifecycle, reload
  // events, follow-scroll, stats, and chat-preview all have focused unit tests.
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import { marked } from 'marked';
  import { escapeHtml } from '../../session/render/session-format.js';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import {
    clearChatPreviewState,
    finishChatPreviewState,
    renderChatPreviewState,
    renderPendingChatState,
  } from '../../session/live/chat-preview.js';
  import { handleSessionReload } from '../../session/live/live-events.js';
  import { setupSessionLiveConnection } from '../../session/live/live-connection.js';
  import { createFollowScrollController } from '../../session/live/live-follow.js';
  import { updateStatsDom } from '../../session/live/live-stats.js';
  import { sessionRuntime } from '../../session/session-runtime.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import { setSessionTitle } from '../../session/session-title.svelte.js';

  let { sessionId, thinkingPreviews = $bindable([]) } = $props();

  onMount(() => {
    const scope = new AbortController();
    const documentImpl = document;
    const windowImpl = window;
    const runtime = getSessionRuntime();
    const model = runtime.model;
    const reconcileEntries = runtime.reconcileEntries || (() => {});
    globalThis.__PI_TEST_LIVE_RELOAD_HOOK__?.();

    const fetchImpl = windowImpl.fetch.bind(windowImpl);
    const requestAnimationFrame = windowImpl.requestAnimationFrame.bind(windowImpl);
    const setTimeout = windowImpl.setTimeout.bind(windowImpl);

    const cleanups = [() => scope.abort()];
    const on = (host, type, handler, opts) => {
      host.addEventListener(type, handler, opts);
      cleanups.push(() => host.removeEventListener(type, handler, opts));
    };

    // Markdown for the streaming preview — globally-configured (sanitized) marked
    // with an escapeHtml fallback (matches the former live-renderer.renderMarkdown).
    const renderMarkdown = (text) => {
      try {
        return safeMarkedParse(text, { marked });
      } catch {
        return escapeHtml(text, { documentImpl });
      }
    };

    // New-entry highlight (after Svelte renders the reactive path).
    function highlightNewEntry(node) {
      node.classList.add('new-entry-highlight');
      setTimeout(() => {
        node.classList.remove('new-entry-highlight');
      }, 1500);
    }
    function highlightNewEntries(newIds) {
      requestAnimationFrame(() => {
        if (scope.signal.aborted) return;
        newIds.forEach((id) => {
          const el = documentImpl.getElementById('entry-' + id);
          if (el) highlightNewEntry(el);
        });
      });
    }

    // "seen" set seeded from the model (the DOM may not be flushed yet at startup).
    const LIVE_ENTRY_STATE = {
      seen: new Set((model?.entries || []).map((e) => e.id).filter(Boolean)),
      liveRendered: new Set(),
    };

    // ── Follow mode (auto-scroll + follow-button decisions) ────────────────────
    // The controller registers its own scroll/wheel/touch/keydown listeners and
    // performs the initial scroll-to-bottom; we just dispose it on unmount.
    const followScroll = createFollowScrollController({
      documentImpl,
      windowImpl,
      requestAnimationFrameImpl: requestAnimationFrame,
      setTimeoutImpl: setTimeout,
    });
    cleanups.push(followScroll.dispose);
    const {
      shouldFollow,
      forceFollowToBottom,
      scrollAfterLayout,
      showFollowButton,
      incrementPending,
      isFollowing,
      isAtBottom,
    } = followScroll;

    on(windowImpl, 'pi-chat-message-sent', (event) => {
      if (event.detail?.steering) return;
      followScroll.extendPreviewFollow(30000);
      if (event && event.detail && event.detail.message) {
        // The transcript preview now shows progress; tell the composer.
        if (renderPendingChat(event.detail.message)) publishPhase('working');
      } else {
        forceFollowToBottom(true);
      }
    });
    on(windowImpl, 'pi-chat-message-failed', (event) => {
      if (!event.detail?.steering) clearChatPreviewState(CHAT_PREVIEW_STATE);
    });

    function updateStats(entries) {
      return updateStatsDom(entries, { documentImpl });
    }
    function updateTitle(name) {
      setSessionTitle(name);
    }

    // ── Streaming chat preview ─────────────────────────────────────────────────
    const CHAT_PREVIEW_STATE = { chatPreviewEl: null, pendingUserEl: null };
    cleanups.push(() => clearChatPreviewState(CHAT_PREVIEW_STATE));
    const assistantTimestamps = (entries) =>
      new Set(
        entries
          .filter(({ message }) => message?.role === 'assistant')
          .map(({ message }) => message.timestamp),
      );
    let persistedAssistantTimestamps = assistantTimestamps(model?.entries || []);

    let lastComposerInput = -Infinity;
    let composing = false;
    on(documentImpl, 'input', ({ target }) => {
      if (target?.id === 'pi-chat-message') lastComposerInput = windowImpl.performance.now();
    });
    on(documentImpl, 'compositionstart', ({ target }) => {
      if (target?.id === 'pi-chat-message') composing = true;
    });
    on(documentImpl, 'compositionend', ({ target }) => {
      if (target?.id !== 'pi-chat-message') return;
      composing = false;
      lastComposerInput = windowImpl.performance.now();
    });
    on(documentImpl, 'focusout', ({ target }) => {
      if (target?.id === 'pi-chat-message') composing = false;
    });
    function editingMessage() {
      return (
        documentImpl.activeElement?.id === 'pi-chat-message' &&
        (composing ||
          documentImpl.documentElement.classList.contains('pi-keyboard-open') ||
          windowImpl.performance.now() - lastComposerInput < 240)
      );
    }

    function clearChatPreview(entries = []) {
      const statusEl = documentImpl.getElementById('pi-chat-status');
      const isChatRunning = statusEl && statusEl.classList.contains('running');
      const hasDoneClass =
        CHAT_PREVIEW_STATE.chatPreviewEl &&
        CHAT_PREVIEW_STATE.chatPreviewEl.classList.contains('done');
      const keepAssistant = !!((CHAT_PREVIEW_STATE.phase || isChatRunning) && !hasDoneClass);
      const timestamp = CHAT_PREVIEW_STATE.messageTimestamp;
      if (
        timestamp &&
        entries.some(
          ({ message }) => message?.role === 'assistant' && message.timestamp === timestamp,
        )
      ) {
        const body = CHAT_PREVIEW_STATE.chatPreviewEl?.querySelector('.message-content');
        if (body) body.replaceChildren();
        CHAT_PREVIEW_STATE.content = '';
      }
      return clearChatPreviewState(CHAT_PREVIEW_STATE, { keepAssistant });
    }
    let lastPhase = '';
    function publishPhase(phase, { toolName, toolElapsedMs } = {}) {
      if (lastPhase === phase && phase !== 'tool') return;
      lastPhase = phase;
      windowImpl.dispatchEvent(
        new CustomEvent('pi:chat-phase', { detail: { sessionId, phase, toolName, toolElapsedMs } }),
      );
    }
    function finishChatPreview() {
      finishChatPreviewState(CHAT_PREVIEW_STATE);
      publishPhase('');
    }
    let previewFrame = 0;
    let previewDelay = 0;
    let lastPreviewPaint = -Infinity;
    let pendingPreview;
    function cancelPreviewPaint() {
      windowImpl.cancelAnimationFrame(previewFrame);
      windowImpl.clearTimeout(previewDelay);
      previewFrame = previewDelay = 0;
    }
    cleanups.push(cancelPreviewPaint);
    function applyChatPreview(payload) {
      if (!payload) return;
      lastPreviewPaint = windowImpl.performance.now();
      const timestamp = payload.messageTimestamp;
      const persisted = persistedAssistantTimestamps.has(timestamp);
      let layoutChanged = false;
      if (timestamp && payload.thinking?.trim() && !persisted) {
        const previous = thinkingPreviews.find((item) => item.messageTimestamp === timestamp);
        if (previous) {
          if (previous.latest !== payload.thinking) {
            previous.latest = payload.thinking;
            previous.liveText.set(payload.thinking);
            layoutChanged = true;
          }
        } else {
          // Only the first chunk adds an activity step. Later updates reach its leaf
          // directly without walking every already rendered message and tool run.
          thinkingPreviews = [
            ...thinkingPreviews,
            {
              messageTimestamp: timestamp,
              thinkingIndex: payload.thinkingIndex || 0,
              thinking: payload.thinking,
              latest: payload.thinking,
              liveText: writable(payload.thinking),
            },
          ].slice(-12);
          layoutChanged = true;
        }
      }
      CHAT_PREVIEW_STATE.messageTimestamp = timestamp || 0;
      const effective = timestamp
        ? { ...payload, thinking: '', content: persisted ? '' : payload.content }
        : payload;
      const rendered = renderChatPreviewState(effective, CHAT_PREVIEW_STATE, {
        documentImpl,
        windowImpl,
        renderMarkdown,
        onLayoutChanged: () => (layoutChanged = true),
        markdownIntervalMs: 0,
      });
      if (layoutChanged)
        followScroll.followPreview(CHAT_PREVIEW_STATE.chatPreviewEl, editingMessage);
      if (rendered) publishPhase(CHAT_PREVIEW_STATE.phase, payload);
    }
    function renderChatPreview(payload) {
      if (payload?.done) {
        cancelPreviewPaint();
        pendingPreview = null;
        applyChatPreview(payload);
        return;
      }
      pendingPreview = payload;
      if (previewFrame || previewDelay) return;
      const paint = () => {
        previewDelay = 0;
        previewFrame = requestAnimationFrame(() => {
          previewFrame = 0;
          applyChatPreview(pendingPreview);
          pendingPreview = null;
        });
      };
      const paintInterval = editingMessage() ? 240 : 100;
      const wait = paintInterval - (windowImpl.performance.now() - lastPreviewPaint);
      if (wait > 0) previewDelay = setTimeout(paint, wait);
      else paint();
    }
    function renderPendingChat(message) {
      return renderPendingChatState(message, CHAT_PREVIEW_STATE, {
        documentImpl,
        windowImpl,
        renderMarkdown,
        shouldFollow,
        forceFollowToBottom,
        scrollAfterLayout,
      });
    }

    // ── Reload (fetch /api/session → reconcile the model) ──────────────────────
    let reloadInFlight;
    let reloadRequested = false;
    async function reloadOnce() {
      await handleSessionReload({
        sessionId,
        fetchImpl,
        signal: scope.signal,
        entryState: LIVE_ENTRY_STATE,
        clearChatPreview,
        // Reactive mode: the Svelte model owns #messages, so no DOM patchers.
        updateStats,
        updateTitle,
        isFollowing,
        isAtBottom,
        scrollAfterLayout,
        incrementPending,
        showFollowButton,
        onReloaded: (data) => {
          persistedAssistantTimestamps = assistantTimestamps(data.entries);
          reconcileEntries(data.entries);
          if (thinkingPreviews.length) {
            const uncommitted = thinkingPreviews.filter(
              (item) => !persistedAssistantTimestamps.has(item.messageTimestamp),
            );
            if (uncommitted.length !== thinkingPreviews.length) thinkingPreviews = uncommitted;
          }
        },
        onNewEntries: highlightNewEntries,
      }).catch((err) => {
        if (!scope.signal.aborted) console.error('Live update failed:', err);
      });
    }
    function triggerReload() {
      reloadRequested = true;
      if (!reloadInFlight) {
        reloadInFlight = (async () => {
          do {
            reloadRequested = false;
            await reloadOnce();
          } while (reloadRequested && !scope.signal.aborted);
        })().finally(() => {
          reloadInFlight = null;
        });
      }
      return reloadInFlight;
    }

    on(windowImpl, 'pi-worker-done', () => {
      // If the final filesystem reload is missed/delayed, don't leave the
      // streaming preview "working"; proactively reconcile from /api/session.
      if (pendingPreview) {
        cancelPreviewPaint();
        applyChatPreview(pendingPreview);
        pendingPreview = null;
      }
      finishChatPreview();
      triggerReload();
    });

    const liveConnection = setupSessionLiveConnection({
      documentImpl,
      windowImpl,
      sessionId,
      onReload: triggerReload,
      onChatPreview: renderChatPreview,
      onAnnotations: (list) => sessionRuntime.annotations?.setAnnotations(list),
    });
    liveConnection.connect();
    cleanups.push(liveConnection.dispose);

    return () => {
      for (const fn of cleanups) fn();
    };
  });
</script>

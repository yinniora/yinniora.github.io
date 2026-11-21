// Runtime glue between the chat-composer DOM and the reactive QueueStore that
// drives <QueuePanel>. Pure JS so it can be unit-tested without Svelte.
//
//   - Steer: the message is sent immediately to /api/chat. Because the worker
//     is already running, the server tags the prompt streamingBehavior:"steer"
//     so pi folds it into the active turn. The steer row in the panel is
//     browser-local and disappears either when the user dismisses it or when
//     the run completes.
//   - Queue: enqueueing goes through POST /api/chat/queue; the autonomous
//     server-side drainer dispatches items to the worker when it becomes idle
//     (or via a kick from the queue API). The browser is just a viewer onto
//     the server-side queue, kept in sync by SSE 'queue' events.
//   - sendNow: the server dispatches the queue item and removes it on ack.
//   - edit: remove the saved item before moving its text back to the composer.
//
import { t } from '../../../shared/i18n.js';

export function setupSteerQueue({
  windowImpl = window,
  store,
  queueButton,
  textarea,
  attachments = { files: () => [], composeMessage: (typed) => typed, clear: () => {} },
  notify = () => {},
  autoResizeTextarea = () => {},
  updateSendEnabled = () => {},
  queueApi = null,
  getLiveEntries = null,
  isRunning = null,
} = {}) {
  if (!store) throw new Error('setupSteerQueue: store is required');

  let activeRun = false;
  const sending = new Set();
  const steerRequests = new WeakMap();

  function reportFailure(error) {
    const message =
      error?.message === 'session is busy' ? t('piSession.busy') : t('activity.failed');
    notify(message);
  }

  function hasContent() {
    const typed = textarea ? textarea.value.trim() : '';
    return typed.length > 0 || !!attachments.files?.().length;
  }

  function updateQueueEnabled() {
    if (queueButton) queueButton.disabled = !hasContent();
  }

  async function enqueueFromComposer() {
    const text = textarea?.value || '';
    const displayText = text.trim();
    const message = attachments.composeMessage(displayText);
    const files = (attachments.files?.() || []).slice();
    const detail = {
      files,
      draft: { text, textAttachments: attachments.textAttachments?.() || [] },
    };
    if (!message && files.length === 0) return false;
    // Clear the composer synchronously so a rapid second queue click can read
    // fresh content from the textarea before our POST round-trips. The store
    // mutation lands later when api.add resolves.
    if (textarea) textarea.value = '';
    attachments.clear?.();
    autoResizeTextarea();
    updateSendEnabled();
    updateQueueEnabled();
    if (textarea && typeof textarea.focus === 'function') textarea.focus();
    if (await store.enqueueQueued({ message, displayText, files })) return true;
    restoreDraft({ detail });
    reportFailure();
    return false;
  }

  async function sendNow(id) {
    const focused = store.items.find((it) => it.id === id);
    if (!focused || focused.kind !== 'queued' || !queueApi || sending.has(id)) return;
    const steering = isRunning?.() ?? activeRun;
    const before = userEntryIds(getLiveEntries?.() || []);
    sending.add(id);
    try {
      await queueApi.sendNow(focused.position);
      store.takeLocalById(id);
      if (steering && (isRunning?.() ?? activeRun)) {
        const consumed = (getLiveEntries?.() || []).some(
          ({ id, message }) =>
            id &&
            !before.has(id) &&
            message?.role === 'user' &&
            matchesSteer(extractUserText(message.content).trim(), focused.text),
        );
        if (!consumed) store.pushSteer({ text: focused.text });
      }
    } catch (error) {
      reportFailure(error);
      await store.refresh?.();
    } finally {
      sending.delete(id);
    }
  }

  async function edit(id) {
    const focused = store.items.find((it) => it.id === id);
    if (!focused || focused.kind !== 'queued' || sending.has(id)) return;
    sending.add(id);
    try {
      const item = await queueApi?.remove(focused.position, { edit: true });
      const payload = item?.attachments;
      const files = (payload?.Files || []).map(({ Name, Data }) => decodeFile(Name, Data));
      for (const [index, image] of (payload?.Images || []).entries()) {
        const extension = image.mimeType.split('/')[1];
        files.push(decodeFile(`image-${index + 1}.${extension}`, image.data, image.mimeType));
      }
      store.takeLocalById(id);
      restoreDraft({ detail: { draft: { text: item?.message ?? focused.text }, files } });
    } catch (error) {
      reportFailure(error);
    } finally {
      sending.delete(id);
      void store.refresh?.();
    }
  }

  function decodeFile(name, data, type = '') {
    const bytes = Uint8Array.from(windowImpl.atob(data), (character) => character.charCodeAt(0));
    return new windowImpl.File([bytes], name, { type });
  }

  function restoreDraft(item) {
    if (!textarea) return;
    const original = item.detail?.draft?.text ?? item.displayText ?? item.text ?? '';
    textarea.value = [original, textarea.value].filter(Boolean).join('\n\n');
    if (item.detail) {
      attachments.restore?.({
        files: [...(item.detail.files || []), ...attachments.files()],
        textAttachments: [
          ...(item.detail.draft?.textAttachments || []),
          ...(attachments.textAttachments?.() || []),
        ],
      });
    }
    autoResizeTextarea();
    updateSendEnabled();
    updateQueueEnabled();
    if (typeof textarea.focus === 'function') textarea.focus({ preventScroll: true });
  }

  // Only a draft that has not been dispatched can be edited or requeued.
  function editSteer(id) {
    const item = store.items.find((it) => it.id === id && it.kind === 'steer');
    if (!item?.detail?.cancelBeforeSend?.()) return false;
    store.takeLocalById(id);
    restoreDraft(item);
    return true;
  }

  function withdrawSteer(id) {
    const item = store.items.find((it) => it.id === id && it.kind === 'steer');
    if (!item?.detail?.cancelBeforeSend?.()) return false;
    store.takeLocalById(id);
    if (store.steerCount === 0 && store.queuedCount === 0 && textarea) {
      textarea.focus({ preventScroll: true });
    }
    return true;
  }

  // Re-file the steer as a normal queued message: it runs after the current
  // turn instead of being folded into it.
  async function queueSteer(id) {
    const item = store.items.find((it) => it.id === id && it.kind === 'steer');
    if (!queueApi || !item?.detail?.cancelBeforeSend?.()) return false;
    store.takeLocalById(id);
    const added = await store.enqueueQueued({
      message: item.text,
      displayText: item.displayText,
      files: item.detail.files,
    });
    if (added) return true;
    restoreDraft(item);
    reportFailure();
    return false;
  }

  async function resume() {
    await store.setPaused(false);
    // The server-side drainer kicks itself on PATCH, so no client-side
    // dispatch is needed.
  }

  const onMessageSent = (event) => {
    const detail = event.detail;
    if (detail && (detail.steering ?? activeRun)) {
      steerRequests.set(
        detail,
        store.pushSteer({ text: detail.message, detail, displayText: detail.draft?.text }),
      );
    }
    activeRun = true;
  };
  const onMessageDelivering = (event) => {
    const id = steerRequests.get(event.detail);
    const row = store.items.find((item) => item.id === id);
    if (row) row.editable = false;
  };
  const onMessageFailed = (event) => {
    if (!event.detail?.steering) activeRun = false;
    const id = steerRequests.get(event.detail);
    if (id) store.takeLocalById(id);
  };

  const onWorkerDone = () => {
    activeRun = false;
    store.clearSteers();
    // Server drainer dispatches the next queued message; SSE 'queue' event
    // will refresh the panel so the head item disappears from the list.
  };

  // When pi folds a steer into the active turn it appends a user entry to the
  // session JSONL. The live reload fires `pi-session-reload`; we then drop the
  // matching steer chip so it disappears as soon as the steer is observably
  // picked up, instead of waiting until the whole run completes.
  function extractUserText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    return '';
  }

  function userEntryIds(entries) {
    const ids = new Set();
    for (const entry of entries) {
      if (entry?.type === 'message' && entry.message?.role === 'user' && entry.id)
        ids.add(entry.id);
    }
    return ids;
  }

  // Pi decorates the stored prompt in ways we do not control (a `[steer] `
  // prefix, an appended `(with cwd context)`, an injected image note). Compare
  // on normalised text so a decorated entry still clears its chip.
  function normalizeSteerText(text) {
    return String(text ?? '')
      .replace(/^\[steer\]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchesSteer(text, draft) {
    const own = normalizeSteerText(draft);
    if (!own) return false;
    const stored = normalizeSteerText(text);
    return stored === own || stored.startsWith(own + ' (') || stored.startsWith(own + ' [Image');
  }

  // Track user entries by id, not by count: a compaction can shrink the live
  // projection, and a count delta then never sees the steer land.
  let seenUserIds = getLiveEntries ? userEntryIds(getLiveEntries() || []) : new Set();

  function reconcileSteersAgainstEntries() {
    if (!getLiveEntries) return;
    const entries = getLiveEntries() || [];
    const fresh = [];
    for (const entry of entries) {
      if (entry?.type !== 'message' || entry.message?.role !== 'user' || !entry.id) continue;
      if (seenUserIds.has(entry.id)) continue;
      seenUserIds.add(entry.id);
      fresh.push(extractUserText(entry.message.content).trim());
    }
    if (store.steerCount === 0 || fresh.length === 0) return;

    for (const text of fresh) {
      const chip = store.items.find(
        (item) => item.kind === 'steer' && !item.editable && matchesSteer(text, item.text),
      );
      if (chip) store.takeLocalById(chip.id);
    }
  }

  store.actions.sendNow = sendNow;
  store.actions.edit = edit;
  store.actions.resume = resume;
  store.actions.editSteer = editSteer;
  store.actions.withdrawSteer = withdrawSteer;
  store.actions.queueSteer = queueSteer;

  queueButton?.addEventListener('click', enqueueFromComposer);
  textarea?.addEventListener('input', updateQueueEnabled);
  windowImpl.addEventListener('pi-chat-message-sent', onMessageSent);
  windowImpl.addEventListener('pi-chat-message-failed', onMessageFailed);
  windowImpl.addEventListener('pi-chat-message-delivering', onMessageDelivering);
  windowImpl.addEventListener('pi-worker-done', onWorkerDone);
  windowImpl.addEventListener('pi-session-reload', reconcileSteersAgainstEntries);

  updateQueueEnabled();

  return {
    enqueueFromComposer,
    sendNow,
    edit,
    editSteer,
    withdrawSteer,
    queueSteer,
    resume,
    queuedCount: () => store.queuedCount,
    steerCount: () => store.steerCount,
    dispose: () => {
      queueButton?.removeEventListener('click', enqueueFromComposer);
      textarea?.removeEventListener('input', updateQueueEnabled);
      windowImpl.removeEventListener('pi-chat-message-sent', onMessageSent);
      windowImpl.removeEventListener('pi-chat-message-failed', onMessageFailed);
      windowImpl.removeEventListener('pi-chat-message-delivering', onMessageDelivering);
      windowImpl.removeEventListener('pi-worker-done', onWorkerDone);
      windowImpl.removeEventListener('pi-session-reload', reconcileSteersAgainstEntries);
    },
  };
}

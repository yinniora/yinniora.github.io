// Runtime glue between the chat-composer DOM and the reactive QueueStore that
// drives <QueuePanel>. Pure JS so it can be unit-tested without Svelte.
//
//   - Steer: after the edit window, the worker folds the message into the active
//     turn. The browser-local row disappears when Pi records the delivery.
//   - Queue: enqueueing goes through POST /api/chat/queue; the autonomous
//     server-side drainer dispatches items to the worker when it becomes idle
//     (or via a kick from the queue API). The browser is just a viewer onto
//     the server-side queue, kept in sync by SSE 'queue' events.
//   - sendNow: the server dispatches the queue item and removes it on ack.
//   - edit: remove the saved item before moving its text back to the composer.
//
import { t } from '../../../shared/i18n.js';

const storedFileList =
  /(?:^|\r?\n\r?\n)Files attached by the user \(stored on the computer\):(?:\r?\n- "(?:[^"\\\r\n]|\\.)*")+$/;
const storedImageHints = /(?:\s*\[Image:[^\]\r\n]*\])+\s*$/;
const leadingImageHints = /^(?:\[Image:[^\]\r\n]*\]\r?\n)+/;
const expandedSkill =
  /^<skill name="([^"]+)" location="[^"\r\n]+">\r?\n[\s\S]*\r?\n<\/skill>(?:\r?\n\r?\n|$)/;

function isUserEntry(entry) {
  return entry?.type === 'message' && entry.message?.role === 'user' && entry.id;
}

function userEntryIds(entries) {
  return new Set(entries.filter(isUserEntry).map(({ id }) => id));
}

function userEntryTime(entry) {
  const time = Date.parse(entry.timestamp);
  if (Number.isFinite(time)) return time;
  return Number.isFinite(entry.message.timestamp) ? entry.message.timestamp : 0;
}

function normalizeSteerText(text) {
  return String(text ?? '')
    .replace(/^\[steer\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function steeredUserMessage(content) {
  const blocks = Array.isArray(content) ? content : [];
  const raw =
    typeof content === 'string'
      ? content
      : blocks.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  const hasImageBlock = blocks.some((part) => part?.type === 'image');
  const bare = raw
    .replace(storedImageHints, '')
    .replace(storedFileList, '')
    .replace(leadingImageHints, '');
  const skill = bare.match(expandedSkill);
  return {
    raw: normalizeSteerText(raw),
    bare: normalizeSteerText(bare),
    skillInput: skill && normalizeSteerText(`/skill:${skill[1]} ${bare.slice(skill[0].length)}`),
    hasAttachments: raw !== bare || hasImageBlock,
    hasImageBlock,
  };
}

function matchesSteer(stored, item) {
  const own = normalizeSteerText(item.text);
  const hasAttachments = Boolean(item.hasAttachments || item.detail?.files?.length);
  if (own && stored.raw === own && !hasAttachments && !stored.hasImageBlock) return true;
  if (hasAttachments !== stored.hasAttachments) return false;
  if (!own) return stored.bare === '' && hasAttachments;
  const withLegacyCwdNote = own + ' (with cwd context)';
  return [stored.raw, stored.bare, stored.skillInput].some(
    (text) => text === own || text === withLegacyCwdNote,
  );
}

export function setupSteerQueue({
  windowImpl = window,
  sessionId = '',
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
    const previousTime = latestUserEntryTime;
    sending.add(id);
    try {
      await queueApi.sendNow(focused.position);
      store.takeLocalById(id);
      if (steering && (isRunning?.() ?? activeRun)) {
        const consumed = (getLiveEntries?.() || []).some(
          (entry) =>
            isUserEntry(entry) &&
            !before.has(entry.id) &&
            (!userEntryTime(entry) || userEntryTime(entry) >= previousTime) &&
            matchesSteer(steeredUserMessage(entry.message.content), focused),
        );
        if (!consumed) store.pushSteer(focused);
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
    // A delayed completion can belong to the run that was active when a new
    // guide was staged. Its card keeps waiting for its own delivery.
    store.clearSteers();
    // Server drainer dispatches the next queued message; SSE 'queue' event
    // will refresh the panel so the head item disappears from the list.
  };

  function onPromptHandled({ detail }) {
    if (!detail?.requestId || detail.sessionId !== sessionId) return;
    const row = store.items.find(
      (item) =>
        item.kind === 'steer' && !item.editable && item.detail?.requestId === detail.requestId,
    );
    if (row) store.takeLocalById(row.id);
  }

  // Entry IDs survive compaction. The timestamp boundary prevents an older
  // page of history from being mistaken for a newly delivered steer.
  const initialEntries = (getLiveEntries?.() || []).filter(isUserEntry);
  const seenUserIds = new Set(initialEntries.map(({ id }) => id));
  let latestUserEntryTime = initialEntries.reduce(
    (latest, entry) => Math.max(latest, userEntryTime(entry)),
    0,
  );

  function reconcileSteersAgainstEntries(event) {
    if (event.detail?.sessionId && event.detail.sessionId !== sessionId) return;
    if (!getLiveEntries) return;
    const previousTime = latestUserEntryTime;
    for (const entry of getLiveEntries() || []) {
      if (!isUserEntry(entry)) continue;
      if (seenUserIds.has(entry.id)) continue;
      seenUserIds.add(entry.id);
      const time = userEntryTime(entry);
      latestUserEntryTime = Math.max(latestUserEntryTime, time);
      if ((time && time < previousTime) || store.steerCount === 0) continue;
      const stored = steeredUserMessage(entry.message.content);
      const chip = store.items.find(
        (item) => item.kind === 'steer' && !item.editable && matchesSteer(stored, item),
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
  windowImpl.addEventListener('pi-chat-prompt-handled', onPromptHandled);
  windowImpl.addEventListener('pi-session-entries-reconciled', reconcileSteersAgainstEntries);

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
      windowImpl.removeEventListener('pi-chat-prompt-handled', onPromptHandled);
      windowImpl.removeEventListener(
        'pi-session-entries-reconciled',
        reconcileSteersAgainstEntries,
      );
    },
  };
}

import { appendChatFiles } from './queue-api.js';

// A phone that lost its link to the Mac usually reconnects on its own within a
// few seconds. Rather than throwing the draft away on the first reset, keep the
// request in flight and retry over this window before reporting anything.
const DEFAULT_SEND_RETRY_DEADLINE_MS = 30_000;
const SEND_RETRY_DELAYS_MS = [800, 1600, 3200, 5000, 8000];
const STEER_EDIT_WINDOW_MS = 5000;

// A missing response can happen before or after acceptance. Every retry uses
// the same request ID so pi-web can acknowledge a delivery it already made.
function isConnectionFailure(error) {
  const message = String(error?.message || error || '');
  return /failed to fetch|load failed|network|connection|econnreset|econnrefused|etimedout|socket|timeout|timed out|tls|offline/i.test(
    message,
  );
}

// A gateway that is still starting answers 502/503/504; the prompt never
// reached the worker, so it is retried like a connection failure.
function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function setupChatSubmission({
  windowImpl = window,
  form,
  textarea,
  sendButton,
  cancelButton,
  attachments,
  chatApi,
  sessionId = '',
  isSteering = () => false,
  shouldQueue = () => false,
  enqueueFromComposer = () => {},
  setStatus = () => {},
  autoResizeTextarea = () => {},
  updateSendEnabled = () => {},
  FormDataImpl = FormData,
  CustomEventImpl = CustomEvent,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDeadlineMs = DEFAULT_SEND_RETRY_DEADLINE_MS,
} = {}) {
  let refreshWorkerStatus = async () => {};
  let delivery;

  if (cancelButton) {
    cancelButton.addEventListener('click', async () => {
      delivery?.abort();
      cancelButton.disabled = true;
      setStatus('cancelling', 'running');
      try {
        const response = await chatApi.cancelChat(sessionId);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'cancel failed');
        setStatus('idle', '');
        refreshWorkerStatus();
      } catch (error) {
        setStatus(error.message || String(error), 'error');
      } finally {
        cancelButton.disabled = false;
      }
    });
    // Esc in an empty composer stops the running task, like the Stop button.
    // Popups (slash commands, mentions, selectors) handle Esc first.
    textarea?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (textarea.value.trim() || cancelButton.disabled || cancelButton.style.display === 'none')
        return;
      if (form?.querySelector?.('[aria-expanded="true"]')) return;
      event.preventDefault();
      cancelButton.click();
    });
  }

  async function sendChatMessage(message, files = attachments.files(), draft = null) {
    if (delivery) return false;
    if (!message && files.length === 0) {
      setStatus('message or image required', 'error');
      return false;
    }
    const body = new FormDataImpl();
    body.set('message', message);
    appendChatFiles(body, files);
    sendButton.dataset.sending = '1';
    sendButton.disabled = true;
    const requestId =
      windowImpl.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const detail = { message, files, draft, requestId, steering: isSteering() };
    const scope = new AbortController();
    delivery = scope;
    let resolveStage;
    const staged = new Promise((resolve) => {
      resolveStage = resolve;
    });
    let editable = detail.steering;
    function finishStage(send) {
      if (!editable || scope.signal.aborted) return false;
      editable = false;
      resolveStage(send);
      return true;
    }
    detail.cancelBeforeSend = () => finishStage(false);
    detail.sendNow = () => finishStage(true);
    setStatus('sending', 'running');
    windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-sent', { detail }));
    try {
      if (detail.steering) {
        const abortStage = () => resolveStage(false);
        scope.signal.addEventListener('abort', abortStage, { once: true });
        const send =
          !scope.signal.aborted &&
          (await Promise.race([sleepImpl(STEER_EDIT_WINDOW_MS).then(() => true), staged]));
        scope.signal.removeEventListener('abort', abortStage);
        editable = false;
        if (scope.signal.aborted) {
          windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-failed', { detail }));
          return false;
        }
        if (!send) return true;
        windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-delivering', { detail }));
      }
      const startedAt = Date.now();
      let attempt = 0;
      for (;;) {
        try {
          scope.signal.throwIfAborted();
          const remaining = retryDeadlineMs - (Date.now() - startedAt);
          if (remaining <= 0) throw new Error('connection timed out');
          const response = await chatApi.sendChat(sessionId, body, {
            requestId,
            signal:
              AbortSignal.any?.([scope.signal, AbortSignal.timeout(remaining)]) || scope.signal,
          });
          if (isRetryableStatus(response.status) && Date.now() - startedAt < retryDeadlineMs) {
            const unavailable = new Error('gateway unavailable (' + response.status + ')');
            unavailable.status = response.status;
            throw unavailable;
          }
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'chat request failed');
          setStatus(data.status || 'queued', 'running');
          return true;
        } catch (error) {
          if (scope.signal.aborted) {
            windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-failed', { detail }));
            return false;
          }
          const retryable = isConnectionFailure(error) || isRetryableStatus(error?.status);
          const delay = SEND_RETRY_DELAYS_MS[Math.min(attempt, SEND_RETRY_DELAYS_MS.length - 1)];
          if (!retryable || Date.now() - startedAt + delay > retryDeadlineMs) throw error;
          attempt += 1;
          // The draft stays in flight instead of being handed back to the user;
          // the status line says why nothing appears to happen yet.
          setStatus('reconnecting', 'running');
          await sleepImpl(delay);
        }
      }
    } catch (error) {
      windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-failed', { detail }));
      setStatus(error.message || String(error), 'error');
      return false;
    } finally {
      if (delivery === scope) delivery = null;
      delete sendButton.dataset.sending;
      sendButton.disabled = false;
      updateSendEnabled();
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (delivery) return;
    if (shouldQueue()) {
      await enqueueFromComposer();
      return;
    }
    const typed = textarea.value.trim();
    const filesToSend = attachments.files().slice();
    const textAttachmentsToSend = attachments.textAttachments().slice();
    const message = attachments.composeMessage(typed);
    if (!message && filesToSend.length === 0) {
      setStatus('message or image required', 'error');
      return;
    }

    // Optimistically move the draft out of the composer immediately. If the
    // request fails before pi accepts it, restore the draft so the user can retry.
    textarea.value = '';
    attachments.clear();
    autoResizeTextarea();
    updateSendEnabled();

    const sent = await sendChatMessage(message, filesToSend, {
      text: typed,
      textAttachments: textAttachmentsToSend,
    });
    if (!sent) {
      const newerDraft = textarea.value;
      textarea.value = [typed, newerDraft].filter(Boolean).join('\n\n');
      attachments.restore({
        files: [...new Set([...filesToSend, ...attachments.files()])],
        textAttachments: [...new Set([...textAttachmentsToSend, ...attachments.textAttachments()])],
      });
      autoResizeTextarea();
      updateSendEnabled();
    }
  });

  return {
    sendChatMessage,
    setRefreshWorkerStatus: (fn) => {
      refreshWorkerStatus = typeof fn === 'function' ? fn : async () => {};
    },
  };
}

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
  setStatus = () => {},
  autoResizeTextarea = () => {},
  updateSendEnabled = () => {},
  FormDataImpl = FormData,
  CustomEventImpl = CustomEvent,
} = {}) {
  let refreshWorkerStatus = async () => {};

  if (cancelButton) {
    cancelButton.addEventListener('click', async () => {
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

  async function sendChatMessage(message, files = attachments.files()) {
    if (!message && files.length === 0) {
      setStatus('message or image required', 'error');
      return false;
    }
    const body = new FormDataImpl();
    body.set('message', message);
    for (const file of files) {
      const image = /^image\/(png|jpeg|webp|gif)$/i.test(file.type);
      body.append(image ? 'images' : 'files', file);
    }
    sendButton.dataset.sending = '1';
    sendButton.disabled = true;
    const detail = { message, steering: isSteering() };
    setStatus('sending', 'running');
    windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-sent', { detail }));
    try {
      const response = await chatApi.sendChat(sessionId, body);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'chat request failed');
      setStatus(data.status || 'queued', 'running');
      return true;
    } catch (error) {
      windowImpl.dispatchEvent(new CustomEventImpl('pi-chat-message-failed', { detail }));
      setStatus(error.message || String(error), 'error');
      return false;
    } finally {
      delete sendButton.dataset.sending;
      sendButton.disabled = false;
      updateSendEnabled();
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
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

    const sent = await sendChatMessage(message, filesToSend);
    if (!sent) {
      textarea.value = typed;
      attachments.restore({ files: filesToSend, textAttachments: textAttachmentsToSend });
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

export function createComposerSendState({
  textarea = null,
  sendButton = null,
  getAttachments = () => ({ hasAttachments: () => false }),
  isBlocked = () => false,
} = {}) {
  function hasComposerContent() {
    const value = textarea ? textarea.value : '';
    return (value && value.trim().length > 0) || !!getAttachments()?.hasAttachments?.();
  }

  function updateSendEnabled() {
    if (!sendButton) return;
    // Don't fight transient sending/disabled state set by sendChatMessage.
    if (sendButton.dataset.sending === '1') return;
    sendButton.disabled = isBlocked() || !hasComposerContent();
  }

  return {
    hasComposerContent,
    updateSendEnabled,
  };
}

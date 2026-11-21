export function setupContextPopover({
  documentImpl = document,
  windowImpl = window,
  updateContextUsage = () => {},
} = {}) {
  const usageCapsule = documentImpl.getElementById('pi-chat-context-usage');
  const popover = documentImpl.getElementById('pi-chat-context-popover');

  function position() {
    if (!usageCapsule || !popover) return;
    const capsuleRect = usageCapsule.getBoundingClientRect();
    const shell = documentImpl.querySelector('.pi-chat-shell');
    if (!shell) return;
    const shellRect = shell.getBoundingClientRect();

    const capsuleCenter = capsuleRect.left + capsuleRect.width / 2;
    let popoverLeft = capsuleCenter - shellRect.left - 100;
    if (popoverLeft < 8) popoverLeft = 8;
    const maxLeft = shellRect.width - 208;
    if (popoverLeft > maxLeft) popoverLeft = maxLeft;
    popover.style.left = `${popoverLeft}px`;

    const popoverBottom = shellRect.bottom - capsuleRect.top + 8;
    popover.style.bottom = `${popoverBottom}px`;

    const arrow = popover.querySelector('.pi-popover-arrow');
    if (arrow) {
      const arrowLeft = capsuleCenter - (shellRect.left + popoverLeft);
      const boundedArrowLeft = Math.min(180, Math.max(20, arrowLeft));
      arrow.style.left = `${boundedArrowLeft}px`;
    }
  }

  if (!usageCapsule || !popover) return { position };

  const hide = () => {
    popover.style.display = 'none';
    usageCapsule.setAttribute('aria-expanded', 'false');
  };
  const show = () => {
    popover.style.display = 'block';
    usageCapsule.setAttribute('aria-expanded', 'true');
    updateContextUsage();
    position();
  };

  const onCapsuleClick = (event) => {
    if (event.target.closest('#pi-chat-context-popover')) {
      event.stopPropagation();
      return;
    }
    if (event.target.closest('.pi-popover-close')) {
      hide();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (popover.style.display !== 'none') hide();
    else show();
  };

  const onPopoverClick = (event) => {
    if (event.target.closest('.pi-popover-close')) hide();
    event.stopPropagation();
  };

  const onDocumentClick = (event) => {
    if (popover.style.display === 'none') return;
    if (
      !event.target.closest('#pi-chat-context-usage') &&
      !event.target.closest('#pi-chat-context-popover')
    ) {
      hide();
    }
  };

  const onResize = () => {
    if (popover.style.display !== 'none') position();
  };

  const onKeydown = (event) => {
    if (event.key === 'Escape' && popover.style.display !== 'none') hide();
  };

  usageCapsule.addEventListener('click', onCapsuleClick);
  popover.addEventListener('click', onPopoverClick);
  documentImpl.addEventListener('click', onDocumentClick);
  usageCapsule.addEventListener('keydown', onKeydown);
  windowImpl.addEventListener?.('resize', onResize, { passive: true });

  return {
    position,
    dispose: () => {
      usageCapsule.removeEventListener('click', onCapsuleClick);
      usageCapsule.removeEventListener('keydown', onKeydown);
      popover.removeEventListener('click', onPopoverClick);
      documentImpl.removeEventListener('click', onDocumentClick);
      windowImpl.removeEventListener?.('resize', onResize, { passive: true });
    },
  };
}

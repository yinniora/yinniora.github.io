import { icon, ArrowDown } from '../../shared/icons.js';

export function isAtBottom({ documentImpl = document, windowImpl = window, threshold = 80 } = {}) {
  const content = documentImpl.getElementById('content');
  if (content) {
    return content.scrollHeight - content.scrollTop - content.clientHeight < threshold;
  }

  const root = documentImpl.scrollingElement || documentImpl.documentElement;
  return (
    root.scrollHeight - (windowImpl.scrollY ?? root.scrollTop) - windowImpl.innerHeight < threshold
  );
}

export function scrollToBottom(smooth, { documentImpl = document, windowImpl = window } = {}) {
  const content = documentImpl.getElementById('content');
  const behavior = smooth ? 'smooth' : 'auto';
  if (content) {
    content.scrollTo({ top: content.scrollHeight, behavior });
    return;
  }
  windowImpl.scrollTo({
    top: (documentImpl.scrollingElement || documentImpl.documentElement).scrollHeight,
    behavior,
  });
}

export function scrollElementAboveComposer(
  el,
  smooth,
  { documentImpl = document, windowImpl = window } = {},
) {
  if (!el) {
    scrollToBottom(smooth, { documentImpl, windowImpl });
    return;
  }
  const content = documentImpl.getElementById('content');
  const behavior = smooth ? 'smooth' : 'auto';
  if (content) {
    if (!content.contains(el)) return;
    const contentRect = content.getBoundingClientRect();
    const delta = el.getBoundingClientRect().bottom - (contentRect.bottom - 24);
    if (delta > 0) content.scrollTo({ top: content.scrollTop + delta, behavior });
    return;
  }
  const delta = el.getBoundingClientRect().bottom - (windowImpl.innerHeight - 24);
  if (delta > 0) {
    windowImpl.scrollTo({ top: windowImpl.scrollY + delta, behavior });
  }
}

export function createFollowButton({
  documentImpl = document,
  requestAnimationFrameImpl = requestAnimationFrame,
  onClick,
} = {}) {
  const button = documentImpl.createElement('button');
  button.className = 'follow-button';
  button.setAttribute('aria-label', 'Scroll to bottom');
  button.innerHTML = icon(ArrowDown, { size: 18 });
  documentImpl.body.appendChild(button);
  requestAnimationFrameImpl(() => {
    button.classList.add('visible');
  });
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

export function setFollowButtonText(button, _pendingCount) {
  if (button) button.innerHTML = icon(ArrowDown, { size: 18 });
}

export function removeFollowButton(button, { windowImpl = window } = {}) {
  if (!button) return;
  button.classList.remove('visible');
  windowImpl.setTimeout(() => {
    if (button.parentNode) button.parentNode.removeChild(button);
  }, 200);
}

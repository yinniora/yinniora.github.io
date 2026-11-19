// Links to other sites open in a new window (a browser tab, or the system
// browser inside the Mac, desktop and Android apps) instead of replacing the
// app. Replacing it lost the conversation view and, on return, transient UI
// such as an open question card.

function externalUrl(anchor, location) {
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return null;
  let url;
  try {
    url = new URL(href, location.href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === location.origin ? null : url;
}

export function prepareExternalLink(event, { location = window.location } = {}) {
  if (event.defaultPrevented || event.button > 0) return false;
  const anchor = event.target?.closest?.('a[href]');
  if (!anchor || anchor.hasAttribute('download')) return false;
  if (!externalUrl(anchor, location)) return false;
  anchor.target = '_blank';
  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  anchor.setAttribute('rel', [...rel].join(' '));
  return true;
}

export function installExternalLinks({ documentImpl = document, windowImpl = window } = {}) {
  const onClick = (event) => prepareExternalLink(event, { location: windowImpl.location });
  // Capture so the target is set before the browser's default action, and
  // before component handlers that might stop propagation.
  documentImpl.addEventListener('click', onClick, true);
  documentImpl.addEventListener('auxclick', onClick, true);
  return () => {
    documentImpl.removeEventListener('click', onClick, true);
    documentImpl.removeEventListener('auxclick', onClick, true);
  };
}

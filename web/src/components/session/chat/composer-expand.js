import { t } from '../../../shared/i18n.js';

export function setupComposerExpansion({
  sessionId = '',
  shell,
  expandButton,
  textarea,
  storage,
  onHeightChange = () => {},
} = {}) {
  const storageKey = 'pi-chat:composer-expanded:' + (sessionId || 'default');

  function apply(expanded) {
    if (!shell) return;
    shell.classList.toggle('expanded', !!expanded);
    if (expandButton) {
      const label = t(expanded ? 'activity.collapseShort' : 'composer.expand');
      expandButton.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      expandButton.setAttribute('aria-label', label);
      expandButton.title = label;
    }
    onHeightChange();
  }

  let initialExpanded = false;
  try {
    initialExpanded = storage && storage.getItem(storageKey) === '1';
  } catch {
    // Storage may be unavailable in private browsing or tests.
  }
  apply(initialExpanded);

  function toggle() {
    const willExpand = !shell?.classList.contains('expanded');
    const keyboardOpen =
      textarea?.ownerDocument.documentElement.classList.contains('pi-keyboard-open');
    apply(willExpand);
    try {
      storage?.setItem(storageKey, willExpand ? '1' : '0');
    } catch {
      // Ignore storage availability errors; expansion still works for this page.
    }
    if (willExpand || keyboardOpen) textarea?.focus({ preventScroll: true });
  }

  expandButton?.addEventListener('click', toggle);

  return { apply, storageKey, dispose: () => expandButton?.removeEventListener('click', toggle) };
}

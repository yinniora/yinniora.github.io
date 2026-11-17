export function openHub(view = 'connections', session = {}) {
  window.dispatchEvent(new CustomEvent('pi:hub', { detail: { view, ...session } }));
}

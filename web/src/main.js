import { mount } from 'svelte';
import App from './App.svelte';
import './personal.css';
import { prepareStartupSettings } from './shared/startup-settings.js';
import { lockPageZoom } from './shared/visual-viewport.js';

if (typeof document !== 'undefined') lockPageZoom();

function defaultTarget() {
  if (typeof document === 'undefined') return null;
  return document.getElementById('spa-root') || document.getElementById('app');
}

export function mountApp({ target = defaultTarget(), props = {} } = {}) {
  if (!target) return null;
  return mount(App, { target, props });
}

const appTarget = typeof document !== 'undefined' ? defaultTarget() : null;
if (appTarget && !appTarget.dataset.piWebSvelteMounted) {
  try {
    if (!localStorage.getItem('pi-personal:layout-v1')) {
      localStorage.setItem('pi-share:v1:sidebar-width', '248');
      localStorage.setItem('pi-web:v1:right-sidebar-collapsed', 'true');
      localStorage.setItem('pi-personal:layout-v1', 'true');
    }
  } catch {
    /* Storage may be disabled in private browsing. */
  }
  appTarget.dataset.piWebSvelteMounted = 'true';
  prepareStartupSettings().finally(() => mountApp({ target: appTarget }));
}

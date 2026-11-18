import { mount } from 'svelte';
import App from './App.svelte';
import './personal.css';
import './interaction.css';
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
export let appReady = Promise.resolve(null);
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
  const settingsReady = window.__PI_REMOTE_CLIENT__ ? Promise.resolve() : prepareStartupSettings();
  appReady = settingsReady.then(() => mountApp({ target: appTarget }));
}

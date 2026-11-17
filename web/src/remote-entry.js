import { t, LOCALE_KEY, resetI18n } from './shared/i18n.js';
import { hydrateSettings } from './shared/settings-store.js';
import { applyRemoteSettings } from './shared/settings-live.js';
import { RemoteClient } from './remote/client.js';
import { mount } from 'svelte';
import RemoteConnect from './components/shared/RemoteConnect.svelte';
import { readRemoteConfig, saveRemoteConfig, parsePairingLink } from './remote/config.js';
import { remoteEventSource } from './remote/event-source.js';
import '../../internal/ui/embedded/styles/theme.css';
import '../../internal/ui/embedded/styles/index.css';
import '../../internal/ui/embedded/styles/settings.css';
import '../../internal/ui/embedded/styles/schedules.css';
import '../../internal/ui/embedded/styles/session.css';
import '../../internal/ui/embedded/styles/menu.css';
import '../../internal/ui/embedded/styles/palette.css';
import './personal.css';

const platformFetch = window.fetch.bind(window);
let transportClient = null;
let transportInstalled = false;

async function start() {
  try {
    document.documentElement.dataset.theme =
      localStorage.getItem('pi-web-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (!localStorage.getItem(LOCALE_KEY))
      localStorage.setItem(LOCALE_KEY, navigator.language.startsWith('zh') ? 'zh' : 'en');
  } catch {}
  resetI18n();
  const host = document.getElementById('remote-status');
  let config = readRemoteConfig();
  let initialError = '';
  if (location.hash.startsWith('#pair=')) {
    try {
      config = parsePairingLink(location.href);
    } catch (error) {
      initialError = t(`remote.${error.code || 'invalidPairing'}`);
    }
    history.replaceState({}, '', location.pathname + location.search);
  }
  if (config?.locale) {
    localStorage.setItem(LOCALE_KEY, config.locale);
    resetI18n();
  }
  host.replaceChildren();
  const repairOnly = new URLSearchParams(location.search).has('pairing');
  mount(RemoteConnect, {
    target: host,
    props: {
      initialConfig: config,
      initialError,
      autoConnect: !repairOnly,
      onConnect: async (next, preference) => {
        try {
          saveRemoteConfig(next);
        } catch {
          const error = new Error(t('remote.storageUnavailable'));
          error.code = 'storageUnavailable';
          throw error;
        }
        const client = new RemoteClient(next, { preference });
        try {
          await client.connect();
          await launchWorkspace(client);
        } catch (error) {
          client.peer?.close();
          client.socket?.close();
          throw error;
        }
      },
    },
  });
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/remote-sw.js', { scope: '/' }).catch(() => {});
}

async function launchWorkspace(client) {
  transportClient = client;
  if (!transportInstalled) {
    transportInstalled = true;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
        location.href,
      );
      if (
        url.origin === location.origin &&
        (/^\/api\//.test(url.pathname) ||
          url.pathname === '/events' ||
          url.pathname.startsWith('/sounds/') ||
          url.pathname === '/share')
      )
        return transportClient.fetch(url.pathname + url.search, init);
      return platformFetch(input, init);
    };
    window.EventSource = remoteEventSource({ fetch: (...args) => transportClient.fetch(...args) });
    window.__PI_REMOTE_CLIENT__ = client;
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data?.type !== 'pi-api' || !event.ports[0]) return;
      const port = event.ports[0];
      const abort = new AbortController();
      let reader;
      let permits = 0;
      let reading = false;
      const pump = async () => {
        if (reading || !reader) return;
        reading = true;
        try {
          while (permits > 0) {
            permits--;
            const { done, value } = await reader.read();
            if (done) {
              port.postMessage({ type: 'end' });
              reader = null;
              break;
            }
            const chunk = value.slice().buffer;
            port.postMessage({ type: 'data', data: chunk }, [chunk]);
          }
        } catch {
          port.postMessage({ type: 'error' });
        } finally {
          reading = false;
        }
      };
      port.onmessage = (event) => {
        if (event.data?.type === 'cancel') abort.abort();
        if (event.data?.type === 'pull') {
          permits++;
          pump();
        }
      };
      try {
        const response = await transportClient.fetch(event.data.path, {
          method: event.data.method,
          headers: event.data.headers,
          body: ['GET', 'HEAD'].includes(event.data.method) ? undefined : event.data.body,
          signal: abort.signal,
        });
        port.postMessage({
          type: 'headers',
          status: response.status,
          headers: [...response.headers],
        });
        if (response.body) {
          reader = response.body.getReader();
          pump();
        } else port.postMessage({ type: 'end' });
      } catch {
        port.postMessage({ type: 'error' });
      }
    });
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 3000) {
        transportClient.reconnect(transportClient.preference).catch(() => {});
        hiddenAt = 0;
      }
    });
    window.addEventListener('online', () => transportClient.connect().catch(() => {}));
  }
  window.__PI_REMOTE_CLIENT__ = client;
  await navigator.serviceWorker.register('/remote-sw.js', { scope: '/' });
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error(t('remote.startFailed'))), 10000)),
  ]);
  if (!navigator.serviceWorker.controller)
    await new Promise((resolve, reject) => {
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', ready);
        reject(new Error(t('remote.startFailed')));
      }, 10000);
      navigator.serviceWorker.addEventListener('controllerchange', ready, { once: true });
      if (navigator.serviceWorker.controller) ready();
    });
  try {
    const response = await client.fetch('/api/devices');
    const data = await response.json();
    if (data.connection?.fingerprint === client.config.fingerprint) {
      client.config = { ...client.config, ...data.connection };
      saveRemoteConfig(client.config);
    }
  } catch {
    /* Existing pinned transport remains usable while settings sync is unavailable. */
  }
  const settings = await hydrateSettings({ fetchImpl: window.fetch });
  if (settings)
    applyRemoteSettings(
      { settings },
      { storage: localStorage, documentImpl: document, windowImpl: window, reload: () => {} },
    );
  resetI18n();
  document.getElementById('remote-status').hidden = true;
  await import('./main.js');
}

start().catch(() => {
  const host = document.getElementById('remote-status');
  host.textContent = t('remote.startFailed');
});

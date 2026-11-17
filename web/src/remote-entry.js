import { t, LOCALE_KEY, resetI18n } from './shared/i18n.js';
import { hydrateSettings } from './shared/settings-store.js';
import { applyRemoteSettings } from './shared/settings-live.js';
import { RemoteClient } from './remote/client.js';
import { base64ToBytes, validateRemoteConfig } from './remote/identity.js';
import { remoteEventSource } from './remote/event-source.js';
import '../../internal/ui/embedded/styles/theme.css';
import '../../internal/ui/embedded/styles/index.css';
import '../../internal/ui/embedded/styles/settings.css';
import '../../internal/ui/embedded/styles/schedules.css';
import '../../internal/ui/embedded/styles/session.css';
import '../../internal/ui/embedded/styles/menu.css';
import '../../internal/ui/embedded/styles/palette.css';
import './personal.css';

function showStatus(message, failed = false) {
  const host = document.getElementById('remote-status');
  host.hidden = false;
  host.querySelector('p').textContent = message;
  host.classList.toggle('failed', failed);
}

async function start() {
  if (!localStorage.getItem(LOCALE_KEY))
    localStorage.setItem(LOCALE_KEY, navigator.language.startsWith('zh') ? 'zh' : 'en');
  resetI18n();
  let config;
  if (location.hash.startsWith('#pair='))
    config = JSON.parse(new TextDecoder().decode(base64ToBytes(location.hash.slice(6))));
  else config = JSON.parse(localStorage.getItem('pi-remote:config-v1') || 'null');
  if (!config) {
    showStatus(t('remote.pairFirst'));
    return;
  }
  validateRemoteConfig(config);
  if (config.locale) localStorage.setItem(LOCALE_KEY, config.locale);
  resetI18n();
  const client = new RemoteClient(config);
  showStatus(t('remote.connecting'));
  await client.connect();
  const nativeFetch = window.fetch.bind(window);
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
      return client.fetch(url.pathname + url.search, init);
    return nativeFetch(input, init);
  };
  window.EventSource = remoteEventSource(client);
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
      const response = await client.fetch(event.data.path, {
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
  await navigator.serviceWorker.register('/remote-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
    );
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

start().catch((error) => showStatus(error.message || t('remote.failed'), true));

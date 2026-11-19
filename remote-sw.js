// The independently hosted client sends HTTP over the authenticated page's
// DTLS channel. Media Range requests stream through the same encrypted path.
const CACHE = 'pi-remote-0.1.0-yugo.41';
const SHELL = ['/', '/icon.svg', '/manifest.webmanifest' , "/assets/main-DWP3bNb2.css", "/assets/main-aBkHizKw.js", "/assets/remote-index-NRglzhSa.css", "/assets/remote-index-eCs_OmdZ.js", "/assets/rolldown-runtime-XKyaHtl9.js"];
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await fetch('/', { cache: 'reload' });
      const entry = SHELL.find((path) => /^\/assets\/remote-index-[\w-]+\.js$/.test(path));
      if (!shell.ok || (entry && !(await shell.clone().text()).includes(`src="${entry}"`)))
        throw new Error('Client update is not ready');
      const cache = await caches.open(CACHE);
      await cache.addAll(
        SHELL.slice(1).map(
          (path) =>
            new Request(path, { cache: path.startsWith('/assets/') ? 'default' : 'reload' }),
        ),
      );
      await cache.put('/', shell);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        const old = keys.filter((key) => key.startsWith('pi-remote-') && key !== CACHE);
        // Pages already open may still request assets from the previous build.
        return Promise.all(old.slice(0, -1).map((key) => caches.delete(key)));
      }),
    ]),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (
    /^\/api\//.test(url.pathname) ||
    url.pathname === '/events' ||
    url.pathname.startsWith('/sounds/') ||
    url.pathname === '/share'
  ) {
    event.respondWith(
      (async () => {
        const client =
          (await self.clients.get(event.clientId)) ||
          (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0];
        if (!client)
          return new Response('Open Pi Workspace to connect to the Mac.', { status: 503 });
        const channel = new MessageChannel();
        const method = event.request.method;
        let controller;
        const stream = new ReadableStream({
          start(value) {
            controller = value;
          },
          pull() {
            channel.port1.postMessage({ type: 'pull' });
          },
          cancel() {
            channel.port1.postMessage({ type: 'cancel' });
          },
        });
        const response = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            channel.port1.postMessage({ type: 'cancel' });
            channel.port1.close();
            resolve(new Response('Encrypted connection timed out', { status: 504 }));
          }, 60000);
          channel.port1.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'headers') {
              clearTimeout(timeout);
              resolve(
                new Response(
                  method === 'HEAD' || [204, 205, 304].includes(message.status) ? null : stream,
                  { status: message.status, headers: message.headers },
                ),
              );
            } else if (message.type === 'data') controller.enqueue(new Uint8Array(message.data));
            else if (message.type === 'end') {
              controller.close();
              channel.port1.close();
            } else if (message.type === 'error') {
              clearTimeout(timeout);
              controller.error(new Error('Encrypted connection unavailable'));
              channel.port1.close();
              resolve(new Response('Encrypted connection unavailable', { status: 502 }));
            }
          };
        });
        const body = ['GET', 'HEAD'].includes(event.request.method)
          ? null
          : await event.request.clone().arrayBuffer();
        client.postMessage(
          {
            type: 'pi-api',
            path: url.pathname + url.search,
            method: event.request.method,
            headers: [...event.request.headers],
            body,
          },
          [channel.port2],
        );
        return response;
      })(),
    );
  } else if (event.request.mode === 'navigate' && event.request.method === 'GET') {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match('/'))
        .catch(() => null)
        .then((shell) => shell || fetch('/', { cache: 'no-cache' })),
    );
  } else if (
    event.request.method === 'GET' &&
    (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname))
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        if (url.pathname.startsWith('/assets/')) {
          const previous = await caches.match(event.request);
          if (previous) return previous;
        }
        const response = await fetch(event.request);
        if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
        return response;
      })(),
    );
  }
});

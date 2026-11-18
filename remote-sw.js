// The independently hosted client sends HTTP over the authenticated page's
// DTLS channel. Media Range requests stream through the same encrypted path.
const CACHE = 'pi-remote-0.1.0-yugo.14';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(new Request('/', { cache: 'reload' }))),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
        ),
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
  } else if (event.request.mode === 'navigate') {
    event.respondWith(fetch('/', { cache: 'no-store' }).catch(() => caches.match('/')));
  } else if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

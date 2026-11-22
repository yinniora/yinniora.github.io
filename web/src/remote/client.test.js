import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./identity.js', async (original) => ({
  ...(await original()),
  getDeviceIdentity: vi.fn().mockResolvedValue({}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const config = {
  version: 1,
  fingerprint: Array(32).fill('ab').join(':'),
  signalUrl: 'wss://relay.example/signal',
  iceUrl: 'https://relay.example/ice',
};
it.each([
  ['tailscale', undefined, ['wss://relay.example/signal'], 'all', false],
  [
    'tailscale',
    'wss://mac.tail.example/remote-signal',
    ['wss://mac.tail.example/remote-signal'],
    'all',
    false,
  ],
  ['vps', 'wss://mac.tail.example/remote-signal', ['wss://relay.example/signal'], 'relay', true],
  [
    'auto',
    'wss://mac.tail.example/remote-signal',
    ['wss://mac.tail.example/remote-signal', 'wss://relay.example/signal'],
    'all',
    true,
  ],
  [
    'auto',
    'wss://host.tail.example/remote-signal',
    ['wss://host.tail.example/remote-signal'],
    'all',
    false,
    true,
  ],
  [
    'tailscale',
    'wss://host.tail.example/remote-signal',
    ['wss://host.tail.example/remote-signal'],
    'all',
    false,
    true,
  ],
  [
    'vps',
    'wss://host.tail.example/remote-signal',
    ['wss://host.tail.example/remote-signal'],
    'all',
    false,
    true,
  ],
])(
  'keeps %s routing usable without changing network settings',
  async (preference, directUrl, expected, policy, needsIce, directOnly = false) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: 'turn:relay.example:3478?transport=udp',
              username: 'fixture',
              credential: 'fixture',
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const endpoints = [],
      peers = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url) {
          endpoints.push(url);
          queueMicrotask(() => this.onerror?.());
        }
        close() {
          this.onclose?.();
        }
      },
    );
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor(options) {
          this.options = options;
          peers.push(this);
        }
        createDataChannel() {
          this.channel = {};
          return this.channel;
        }
        close() {
          this.channel.onclose?.();
        }
      },
    );
    const { RemoteClient } = await import('./client.js');
    const routes = directOnly
      ? { version: config.version, fingerprint: config.fingerprint, directUrl }
      : { ...config, directUrl };
    await expect(new RemoteClient(routes, { preference }).connect()).rejects.toThrow();
    expect(endpoints).toEqual(expected);
    expect(peers[0].options.iceTransportPolicy).toBe(policy);
    expect(fetch.mock.calls.length > 0).toBe(needsIce);
  },
);

it('sends only the LAN signaling address and pin to the native socket factory', async () => {
  const lanUrl = 'wss://192.168.2.9:43124/remote-signal';
  const fetch = vi.fn();
  const browserSocket = vi.fn();
  const nativeLANSocket = vi.fn(() => {
    const socket = { close: () => socket.onclose?.() };
    queueMicrotask(() => socket.onerror());
    return socket;
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('WebSocket', browserSocket);
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      createDataChannel() {
        this.channel = {};
        return this.channel;
      }
      close() {
        this.channel.onclose?.();
      }
    },
  );
  const { RemoteClient } = await import('./client.js');
  const direct = { fingerprint: config.fingerprint, lanUrl };
  await expect(new RemoteClient(direct, { nativeLANSocket }).connect()).rejects.toThrow();
  expect(nativeLANSocket).toHaveBeenCalledExactlyOnceWith(lanUrl, config.fingerprint);
  await expect(new RemoteClient(direct, { nativeLANSocket: null }).connect()).rejects.toMatchObject(
    {
      code: 'lanNeedsApp',
    },
  );
  expect(browserSocket).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('reports loading for finite requests without treating the event stream as permanent loading', async () => {
  const { RemoteClient } = await import('./client.js');
  const client = new RemoteClient(config);
  client.connection = 'connected';
  client.authorized = true;
  client.channel = { readyState: 'open' };
  client.peer = { connectionState: 'connected' };
  const packets = [];
  client.send = async (message) => {
    packets.push(message);
    if (message.type === 'request')
      client.receive({ type: 'response', id: message.id, status: 200, headers: {} });
  };
  const events = new AbortController();
  await client.fetch('/events?id=__all__', { signal: events.signal });
  expect(client.status).toBe('connected');
  const response = await client.fetch('/api/projects');
  expect(client.status).toBe('loading');
  const id = packets.findLast((p) => p.type === 'request').id;
  client.receive({ type: 'end', id });
  await response.arrayBuffer();
  expect(client.status).toBe('connected');
  client.setSyncing(true);
  expect(client.status).toBe('syncing');
  client.setSyncing(false);
  client.connection = 'disconnected';
  expect(client.status).toBe('disconnected');
  client.blocked = true;
  expect(client.status).toBe('blocked');
  events.abort();
});

it('reuses a working authenticated channel when the app returns to the foreground', async () => {
  const { RemoteClient } = await import('./client.js');
  const client = new RemoteClient(config);
  client.authorized = true;
  client.channel = { readyState: 'open' };
  client.peer = { connectionState: 'connected' };
  client.fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}'))
    .mockRejectedValueOnce(new Error('stale channel'));
  client.reconnect = vi.fn().mockResolvedValue(undefined);
  await client.resume();
  expect(client.fetch).toHaveBeenCalledWith('/api/version', { signal: expect.anything() });
  expect(client.reconnect).not.toHaveBeenCalled();
  await client.resume();
  expect(client.reconnect).toHaveBeenCalledOnce();
});

it('shares a single channel check across concurrent resume events', async () => {
  const { RemoteClient } = await import('./client.js');
  const client = new RemoteClient(config);
  client.authorized = true;
  client.channel = { readyState: 'open' };
  client.peer = { connectionState: 'connected' };
  client.fetch = vi.fn(async () => new Response('{}'));
  const first = client.resume();
  expect(client.resume()).toBe(first);
  expect(client.resume()).toBe(first);
  await first;
  expect(client.fetch).toHaveBeenCalledOnce();
  await client.resume();
  expect(client.fetch).toHaveBeenCalledTimes(2);
});

it('switches preferences after an in-flight connection has settled', async () => {
  const { RemoteClient } = await import('./client.js');
  const client = new RemoteClient(config);
  const pending = Promise.withResolvers();
  client.connecting = pending.promise.finally(() => {
    client.connecting = null;
  });
  client.peer = { close: vi.fn() };
  client.connect = vi.fn();

  const switchMode = client.reconnect('vps');
  expect(client.preference).toBe('auto');
  expect(client.peer.close).not.toHaveBeenCalled();
  pending.reject(new Error('The previous route failed'));
  await switchMode;
  expect(client.preference).toBe('vps');
  expect(client.peer.close).toHaveBeenCalledOnce();
  expect(client.connect).toHaveBeenCalledOnce();
});

it('reports P2P or relay from the selected candidate pair instead of the chosen preference', async () => {
  const { RemoteClient } = await import('./client.js');
  const client = new RemoteClient(config, { preference: 'vps' });
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
      },
    ],
    ['local', { candidateType: 'host' }],
    ['remote', { candidateType: 'host' }],
  ]);
  client.peer = { getStats: async () => stats };
  await client.updateTransport();
  expect(client.transport).toBe('p2p');
  stats.set('local', { candidateType: 'relay' });
  await client.updateTransport();
  expect(client.transport).toBe('relay');
});

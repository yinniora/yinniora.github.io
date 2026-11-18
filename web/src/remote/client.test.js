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
])(
  'keeps %s routing usable without changing network settings',
  async (preference, directUrl, expected, policy, needsIce) => {
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
    await expect(
      new RemoteClient({ ...config, directUrl }, { preference }).connect(),
    ).rejects.toThrow();
    expect(endpoints).toEqual(expected);
    expect(peers[0].options.iceTransportPolicy).toBe(policy);
    expect(fetch.mock.calls.length > 0).toBe(needsIce);
  },
);

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

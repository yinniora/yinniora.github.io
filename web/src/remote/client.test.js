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
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ iceServers: [] })));
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

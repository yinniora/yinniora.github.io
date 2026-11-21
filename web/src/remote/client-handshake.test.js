import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readRemoteConfig, saveRemoteConfig } from './config.js';
import { authenticateRelay } from './relay-auth.js';
vi.mock('./identity.js', async (original) => ({
  ...(await original()),
  getDeviceIdentity: vi.fn(async () => ({})),
  createDeviceProof: vi.fn(async () => ({ type: 'auth' })),
}));
vi.mock('./relay-auth.js', () => ({
  authenticateRelay: vi.fn(async () => {}),
  relayICEAuthorization: vi.fn(async () => 'fixture-proof'),
}));

const fingerprint = Array(32).fill('ab').join(':');
const config = {
  version: 1,
  fingerprint,
  clientUrl: 'https://client.example/',
  signalUrl: 'wss://relay.example/signal',
  iceUrl: 'https://relay.example/ice',
  relayAuth: true,
  ticket: 'e'.repeat(64),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup({
  status = 200,
  answer = true,
  authorize = true,
  complete = true,
  preference = 'vps',
  routes = {},
  directOpenDelay = 0,
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
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
          { status },
        ),
    ),
  );
  let peer;
  const offers = [];
  const sockets = [];
  vi.stubGlobal(
    'WebSocket',
    class extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        sockets.push(this);
        if (url === routes.directUrl && directOpenDelay)
          setTimeout(() => this.onopen?.(), directOpenDelay);
        else queueMicrotask(() => this.onopen?.());
      }
      send(data) {
        const packet = JSON.parse(data);
        offers.push(packet);
        if (answer && packet.type === 'offer')
          queueMicrotask(() =>
            this.onmessage?.({
              data: JSON.stringify({
                type: 'answer',
                sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\na=candidate:1 1 udp 1 203.0.113.1 3478 typ relay\r\n`,
              }),
            }),
          );
      }
      close() {
        this.closed = true;
        this.dispatchEvent(new Event('close'));
      }
    },
  );
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        peer = this;
        this.connectionState = 'connecting';
        this.iceConnectionState = 'checking';
      }
      createDataChannel() {
        this.channel = {
          readyState: 'open',
          send: () =>
            queueMicrotask(() => this.channel.onmessage?.({ data: '{"type":"authorized"}' })),
        };
        return this.channel;
      }
      async createOffer() {
        return {};
      }
      async setLocalDescription() {
        this.localDescription = {
          sdp: 'v=0\r\na=candidate:1 1 udp 1 203.0.113.1 3478 typ relay\r\n',
        };
        if (complete) {
          this.iceGatheringState = 'complete';
          this.onicegatheringstatechange?.();
        } else this.onicecandidate?.({ candidate: { type: 'relay' } });
      }
      async setRemoteDescription() {
        if (authorize)
          queueMicrotask(() =>
            this.channel.onmessage?.({
              data: JSON.stringify({ type: 'challenge', nonce: 'fixture', fingerprint }),
            }),
          );
      }
      close() {
        this.connectionState = 'closed';
        this.channel.onclose?.();
      }
    },
  );
  const { RemoteClient } = await import('./client.js');
  return {
    client: new RemoteClient({ ...config, ...routes }, { preference }),
    offers,
    sockets,
    getPeer: () => peer,
  };
}

it('keeps a previously authorized direct route until a mixed QR finishes authenticating', async () => {
  const directUrl = 'wss://host.tail.example/remote-signal';
  saveRemoteConfig({ version: 1, fingerprint, clientUrl: config.clientUrl, directUrl });
  const { client } = await setup({ answer: false, routes: { directUrl } });
  const result = client.openConnection().catch((error) => error);
  await vi.advanceTimersByTimeAsync(20001);
  expect((await result).code).toBe('signalTimeout');
  expect(readRemoteConfig()).toEqual({
    version: 1,
    fingerprint,
    clientUrl: config.clientUrl,
    directUrl,
  });
});

it('connects using the direct route when the faster relay socket refuses its capability', async () => {
  const directUrl = 'wss://host.tail.example/remote-signal';
  const relayTicket = 'signed-vps-capability';
  authenticateRelay.mockRejectedValueOnce(
    Object.assign(new Error('denied'), { code: 'relayDenied' }),
  );
  const { client, offers, sockets } = await setup({
    preference: 'auto',
    routes: { directUrl, relayTicket },
    directOpenDelay: 20,
  });
  const result = client.openConnection();
  await vi.advanceTimersByTimeAsync(20);
  await result;
  expect(client.socket.url).toBe(directUrl);
  const relaySocket = sockets.find((socket) => socket.url === config.signalUrl);
  expect(relaySocket.closed).toBe(true);
  expect(authenticateRelay.mock.calls.at(-1)[0]).toBe(relaySocket);
  expect(offers).toHaveLength(1);
  expect(JSON.stringify(offers[0])).not.toContain(relayTicket);
  expect(JSON.stringify(offers[0])).not.toContain(config.ticket);
  expect(readRemoteConfig()).toMatchObject({ directUrl, signalUrl: config.signalUrl, fingerprint });
  expect(readRemoteConfig()).not.toHaveProperty('relayTicket');
  expect(readRemoteConfig()).not.toHaveProperty('ticket');
});

it('reports relay authorization failures before waiting on an impossible relay-only channel', async () => {
  const { client } = await setup({ status: 401 });
  const result = client.connect().catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  const error = await result;
  expect(error.code).toBe('relayDenied');
  expect(error.diagnostics.iceHTTPStatus).toBe(401);
  expect(error.diagnostics.stage).toBe('ice');
  expect(JSON.stringify(error.diagnostics)).not.toContain(config.ticket);
});

it('normalizes browser timeout codes into a readable ICE failure', async () => {
  const { client } = await setup();
  fetch.mockRejectedValueOnce(new DOMException('network timeout', 'TimeoutError'));
  const result = client.connect().catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  const error = await result;
  expect(error.code).toBe('iceUnavailable');
  expect(error.diagnostics.iceError).toBe('timeout');
});

it('sends a usable relay offer promptly and reaches device authorization without waiting for all interfaces', async () => {
  const { client, offers } = await setup({ complete: false });
  const phases = [];
  client.addEventListener('phase', (event) => phases.push(event.detail));
  const result = client.openConnection();
  await vi.advanceTimersByTimeAsync(399);
  expect(offers).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(client.authorized).toBe(true);
  expect(phases).toEqual(
    expect.arrayContaining(['ice', 'signal', 'gathering', 'answer', 'channel', 'auth']),
  );
  expect(client.config.ticket).toBeUndefined();
});

it.each([
  [false, true, 'signalTimeout', 'answer', 20001],
  [true, false, 'channelTimeout', 'channel', 20001],
])(
  'keeps signaling and channel failure diagnoses distinct',
  async (answer, authorize, code, stage, duration) => {
    const { client } = await setup({ answer, authorize });
    const result = client.openConnection().catch((error) => error);
    await vi.advanceTimersByTimeAsync(duration);
    const error = await result;
    expect(error.code).toBe(code);
    expect(error.diagnostics.stage).toBe(stage);
    expect(JSON.stringify(error.diagnostics)).not.toContain(config.ticket);
  },
);

it('reuses unexpired TURN credentials on reconnect and forgets them after a failure', async () => {
  const { client } = await setup();
  const expiry = Math.floor(Date.now() / 1000) + 7200;
  fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: 'turn:relay.example:3478?transport=udp',
              username: `${expiry}:pi-fixture`,
              credential: 'fixture',
            },
          ],
        }),
      ),
  );
  await client.openConnection();
  expect(fetch).toHaveBeenCalledTimes(1);
  await client.openConnection();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.diagnostics.iceCached).toBe(true);
  const { forgetICE } = await import('./client.js');
  forgetICE();
  await client.openConnection();
  expect(fetch).toHaveBeenCalledTimes(2);
});

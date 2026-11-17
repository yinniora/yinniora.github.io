import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { relayICEAuthorization, authenticateRelay } from './relay-auth.js';
import { base64ToBytes } from './identity.js';
afterEach(() => vi.unstubAllGlobals());
const config = {
  signalUrl: 'wss://relay.example/signal?room=' + 'r'.repeat(32),
  relayAuth: true,
  relayTicket: 'short-relay-ticket',
  ticket: 'never-send-this-Mac-ticket',
};
it('signs relay access with a separate domain and never exposes the Mac enrollment secret', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const identity = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const header = await relayICEAuthorization(identity, config);
  const proof = JSON.parse(new TextDecoder().decode(base64ToBytes(header.slice(8))));
  expect(proof.ticket).toBe(config.relayTicket);
  expect(JSON.stringify(proof)).not.toContain(config.ticket);
  expect(proof.publicKey.d).toBeUndefined();
  expect(
    await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity.publicKey,
      base64ToBytes(proof.signature),
      new TextEncoder().encode(
        `pi-relay-ice-v1:${'r'.repeat(32)}:${proof.timestamp}:${proof.nonce}`,
      ),
    ),
  ).toBe(true);
  class Socket extends EventTarget {
    send(value) {
      this.proof = JSON.parse(value);
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: '{"type":"relay-authorized"}' })),
      );
    }
  }
  const socket = new Socket();
  const ready = authenticateRelay(socket, identity, config);
  socket.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'relay-challenge', nonce: 'a'.repeat(64) }),
    }),
  );
  await ready;
  expect(JSON.stringify(socket.proof)).not.toContain(config.ticket);
  expect(socket.proof.ticket).toBe(config.relayTicket);
  expect(
    await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity.publicKey,
      base64ToBytes(socket.proof.signature),
      new TextEncoder().encode(`pi-device-auth-v1:${'a'.repeat(64)}:mac`),
    ),
  ).toBe(false);
});

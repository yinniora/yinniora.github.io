import { expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import {
  parsePairingLink,
  publicRemoteConfig,
  saveRemoteConfig,
  readRemoteConfig,
  CONFIG_KEY,
} from './config.js';
import { readQRCode } from './scan-code.js';
const origin = 'https://pi.example';
const config = {
  version: 1,
  fingerprint: Array(32).fill('ab').join(':'),
  clientUrl: origin + '/',
  signalUrl: 'wss://relay.example/signal?room=public-route',
  iceUrl: 'https://relay.example/ice?room=public-route',
  directUrl: 'wss://mac.tail.example/remote-signal',
  ticket: 'e'.repeat(64),
};
const link = (data = config, host = origin) => host + '/#pair=' + btoa(JSON.stringify(data));
it('accepts a Mac pairing link but rejects external origins and expired codes', () => {
  expect(parsePairingLink(link(), { origin }).ticket).toBe(config.ticket);
  for (const value of [
    link(config, 'https://evil.example'),
    link({ ...config, clientUrl: 'https://evil.example' }),
    'https://pi.example/#pair=bad',
  ])
    expect(() => parsePairingLink(value, { origin })).toThrow();
  expect(() =>
    parsePairingLink(link({ ...config, expiresAt: '2000-01-01T00:00:00Z' }), { origin }),
  ).toThrow('remote.expiredPairing');
});
it('decodes a smaller v2 QR without changing the pinned identity, ticket or routing', () => {
  const compact = [
    2,
    btoa(String.fromCharCode(...Array(32).fill(0xab))),
    btoa(String.fromCharCode(...Array(32).fill(0xee))),
    'https://relay.example',
    'r'.repeat(32),
    'signed-relay-capability',
    Math.floor(Date.now() / 1000) + 180,
    'zh',
    '',
  ];
  const parsed = parsePairingLink(link(compact), { origin });
  expect(parsed.fingerprint).toBe(config.fingerprint);
  expect(parsed.ticket).toBe(config.ticket);
  expect(parsed.signalUrl).toBe('wss://relay.example/signal?room=' + 'r'.repeat(32));
  expect(parsed.iceUrl).toBe('https://relay.example/ice?room=' + 'r'.repeat(32));
  expect(parsed.relayTicket).toBe(compact[5]);
  const storage = { setItem: vi.fn() };
  saveRemoteConfig(parsed, storage);
  expect(storage.setItem.mock.calls[0][1]).not.toContain(parsed.ticket);
  expect(storage.setItem.mock.calls[0][1]).not.toContain(parsed.relayTicket);
  compact[6] = 1;
  expect(() => parsePairingLink(link(compact), { origin })).toThrow('remote.expiredPairing');
});
it('persists public connection data only and does not assume browser storage exists in the Home Screen app', () => {
  const values = new Map();
  const browser = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const app = { getItem: () => null };
  saveRemoteConfig({ ...config, apiKey: 'must-not-save', privateKey: 'must-not-save' }, browser);
  expect(browser.getItem(CONFIG_KEY)).not.toContain(config.ticket);
  expect(browser.getItem(CONFIG_KEY)).not.toContain('must-not-save');
  expect(readRemoteConfig(browser)).toEqual(publicRemoteConfig(config));
  expect(readRemoteConfig(app)).toBeNull();
});
it('decodes a real QR bitmap locally for the in-app camera scanner', () => {
  const value = link();
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const scale = 4,
    margin = 4,
    size = (qr.modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++)
      if (qr.modules.get(y, x))
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
  expect(readQRCode({ data, width: size, height: size })).toBe(value);
});

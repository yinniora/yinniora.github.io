import { expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import {
  parsePairingLink,
  publicRemoteConfig,
  saveRemoteConfig,
  readRemoteConfig,
  readRemoteStartup,
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
    config.directUrl,
  ];
  const parsed = parsePairingLink(link(compact), { origin });
  expect(parsed.fingerprint).toBe(config.fingerprint);
  expect(parsed.ticket).toBe(config.ticket);
  expect(parsed.signalUrl).toBe('wss://relay.example/signal?room=' + 'r'.repeat(32));
  expect(parsed.iceUrl).toBe('https://relay.example/ice?room=' + 'r'.repeat(32));
  expect(parsed.directUrl).toBe(config.directUrl);
  expect(parsed.relayTicket).toBe(compact[5]);
  const storage = { setItem: vi.fn() };
  saveRemoteConfig(parsed, storage);
  expect(storage.setItem.mock.calls[0][1]).not.toContain(parsed.ticket);
  expect(storage.setItem.mock.calls[0][1]).not.toContain(parsed.relayTicket);
  compact[6] = 1;
  expect(() => parsePairingLink(link(compact), { origin })).toThrow('remote.expiredPairing');
});
it('accepts and persists private signaling without any relay URLs', () => {
  const direct = { ...config, signalUrl: '', iceUrl: '', relayAuth: false };
  const parsed = parsePairingLink(link(direct), { origin });
  expect(parsed).toMatchObject({
    directUrl: config.directUrl,
    fingerprint: config.fingerprint,
    ticket: config.ticket,
  });
  const storage = { getItem: vi.fn(), setItem: vi.fn() };
  saveRemoteConfig(parsed, storage);
  const saved = storage.setItem.mock.calls[0][1];
  expect(saved).not.toContain(config.ticket);
  storage.getItem.mockReturnValue(saved);
  expect(readRemoteConfig(storage)).toEqual(publicRemoteConfig(direct));
  for (const broken of [
    { directUrl: 'ws://mac.tail.example/remote-signal' },
    { directUrl: 'wss://user:secret@mac.tail.example/remote-signal' },
    { directUrl: 'wss://mac.tail.example/remote-signal#credential' },
    { signalUrl: config.signalUrl },
    { relayAuth: true },
  ])
    expect(() => parsePairingLink(link({ ...direct, ...broken }), { origin })).toThrow(
      'remote.invalidPairing',
    );
});
it('rejects a relay capability when the pairing code mixes signaling and ICE rooms', () => {
  const relayTicket = 'signed-vps-capability';
  const iceUrl = 'https://relay.example/ice?room=another-route';
  expect(() => parsePairingLink(link({ ...config, iceUrl, relayTicket }), { origin })).toThrow(
    'remote.invalidPairing',
  );
  expect(() =>
    parsePairingLink(link({ ...config, signalUrl: '', iceUrl: '', relayTicket }), { origin }),
  ).toThrow('remote.invalidPairing');
});
it('opens a LAN-only QR in a native app and never accepts a non-LAN endpoint', () => {
  const lan = {
    ...config,
    signalUrl: '',
    iceUrl: '',
    directUrl: '',
    lanUrl: 'wss://192.168.2.9:43124/remote-signal',
  };
  expect(parsePairingLink(link(lan), { origin, nativeLAN: true }).lanUrl).toBe(lan.lanUrl);
  expect(() => parsePairingLink(link(lan), { origin, nativeLAN: false })).toThrow(
    'remote.lanNeedsApp',
  );
  for (const nativeLAN of [false, true]) {
    expect(
      parsePairingLink(link({ ...config, lanUrl: lan.lanUrl }), { origin, nativeLAN }),
    ).toMatchObject({
      lanUrl: lan.lanUrl,
      directUrl: config.directUrl,
      signalUrl: config.signalUrl,
    });
  }
  for (const lanUrl of [
    'wss://127.0.0.1:43124/remote-signal',
    'wss://100.80.2.9:43124/remote-signal',
    'wss://192.168.2.9:43124/api/version',
    'wss://192.168.2.9:43124/remote-signal?key=1',
    'ws://192.168.2.9:43124/remote-signal',
  ])
    expect(() => parsePairingLink(link({ ...lan, lanUrl }), { origin, nativeLAN: true })).toThrow(
      'remote.invalidPairing',
    );
});
it('opens a scanned route update from the repair screen before replacing the working configuration', () => {
  const current = publicRemoteConfig({ ...config, signalUrl: '', iceUrl: '' });
  const storage = { getItem: vi.fn(() => JSON.stringify(current)), setItem: vi.fn() };
  expect(readRemoteStartup(new URL(origin + '/?pairing=1'), storage)).toEqual({
    config: current,
    autoConnect: false,
  });
  const updated = new URL(link());
  updated.searchParams.set('pairing', '1');
  expect(readRemoteStartup(updated, storage)).toEqual({ config, autoConnect: true });
  updated.hash = 'pair=invalid';
  expect(readRemoteStartup(updated, storage)).toMatchObject({
    config: current,
    autoConnect: false,
    error: { code: 'invalidPairing' },
  });
  expect(storage.setItem).not.toHaveBeenCalled();
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

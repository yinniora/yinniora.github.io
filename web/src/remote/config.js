import { base64ToBytes, validateRemoteConfig } from './identity.js';

export const CONFIG_KEY = 'pi-remote:config-v1';
export const TRANSPORT_KEY = 'pi-remote:transport-v1';

export function publicRemoteConfig(config) {
  const result = {};
  for (const key of [
    'version',
    'fingerprint',
    'clientUrl',
    'signalUrl',
    'iceUrl',
    'directUrl',
    'locale',
    'relayAuth',
  ])
    if (config[key] !== undefined) result[key] = config[key];
  return validateRemoteConfig(result);
}

export function parsePairingLink(input, { origin = location.origin, now = Date.now() } = {}) {
  try {
    const text = String(input || '').trim();
    if (!text || text.length > 8192) throw new Error();
    const url = new URL(text, origin);
    if (url.origin !== origin || url.protocol !== 'https:' || !url.hash.startsWith('#pair='))
      throw new Error();
    let config = JSON.parse(new TextDecoder().decode(base64ToBytes(url.hash.slice(6))));
    if (Array.isArray(config)) {
      if (
        config.length !== 9 ||
        config[0] !== 2 ||
        !Number.isSafeInteger(config[6]) ||
        [1, 2, 3, 4, 5, 7, 8].some((index) => typeof config[index] !== 'string')
      )
        throw new Error();
      const pin = base64ToBytes(config[1]),
        ticket = base64ToBytes(config[2]);
      const relay = new URL(config[3]);
      if (
        pin.length !== 32 ||
        ticket.length !== 32 ||
        relay.protocol !== 'https:' ||
        relay.username ||
        relay.password ||
        relay.pathname !== '/' ||
        relay.search ||
        relay.hash ||
        config[4].length < 20 ||
        config[4].length > 128
      )
        throw new Error();
      const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
      const room = new URLSearchParams({ room: config[4] }).toString();
      config = {
        version: 1,
        fingerprint: hex(pin).join(':'),
        ticket: hex(ticket).join(''),
        clientUrl: origin + '/',
        signalUrl: 'wss://' + relay.host + '/signal?' + room,
        iceUrl: relay.origin + '/ice?' + room,
        relayTicket: config[5],
        relayAuth: !!config[5],
        expiresAt: new Date(config[6] * 1000).toISOString(),
        locale: config[7],
        directUrl: config[8],
      };
    }
    if (
      config.version !== 1 ||
      !/^[a-f0-9]{64}$/i.test(config.ticket || '') ||
      new URL(config.clientUrl).origin !== origin
    )
      throw new Error();
    if (
      config.expiresAt &&
      (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= now)
    ) {
      const error = new Error('remote.expiredPairing');
      error.code = 'expiredPairing';
      throw error;
    }
    if (
      config.relayTicket &&
      (typeof config.relayTicket !== 'string' || config.relayTicket.length > 512)
    )
      throw new Error();
    return {
      ...publicRemoteConfig(config),
      ticket: config.ticket,
      ...(config.relayTicket ? { relayTicket: config.relayTicket } : {}),
    };
  } catch (error) {
    if (error.code === 'expiredPairing') throw error;
    const invalid = new Error('remote.invalidPairing');
    invalid.code = 'invalidPairing';
    throw invalid;
  }
}

export function readRemoteConfig(storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(CONFIG_KEY) || 'null');
    return value ? publicRemoteConfig(value) : null;
  } catch {
    return null;
  }
}

export function saveRemoteConfig(config, storage = localStorage) {
  storage.setItem(CONFIG_KEY, JSON.stringify(publicRemoteConfig(config)));
}

export function normalizeTransport(value) {
  if (value === 'remote' || value === 'vps') return 'vps';
  return value === 'tailscale' ? 'tailscale' : 'auto';
}

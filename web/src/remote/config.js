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
    const config = JSON.parse(new TextDecoder().decode(base64ToBytes(url.hash.slice(6))));
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
    return { ...publicRemoteConfig(config), ticket: config.ticket };
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

import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { getDeviceIdentity } from './identity.js';
afterEach(() => vi.unstubAllGlobals());
const fp = Array(32).fill('ab').join(':');
it('keeps browser and Home Screen identities separate and non-extractable', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const browser = await getDeviceIdentity(fp);
  const browserPublic = await webcrypto.subtle.exportKey('jwk', browser.publicKey);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const app = await getDeviceIdentity(fp);
  const appPublic = await webcrypto.subtle.exportKey('jwk', app.publicKey);
  expect(appPublic.x).not.toBe(browserPublic.x);
  expect(app.privateKey.extractable).toBe(false);
  await expect(webcrypto.subtle.exportKey('jwk', app.privateKey)).rejects.toThrow();
});
it('reuses one identity when two windows initialize simultaneously', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const [first, second] = await Promise.all([getDeviceIdentity(fp), getDeviceIdentity(fp)]);
  expect(await webcrypto.subtle.exportKey('jwk', first.publicKey)).toEqual(
    await webcrypto.subtle.exportKey('jwk', second.publicKey),
  );
  const again = await getDeviceIdentity(fp);
  expect(await webcrypto.subtle.exportKey('jwk', again.publicKey)).toEqual(
    await webcrypto.subtle.exportKey('jwk', first.publicKey),
  );
});

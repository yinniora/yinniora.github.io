import { expect, it } from 'vitest';
import { deviceFeatures } from './device-features.js';
it('distinguishes iPhone browser and Home Screen without saving full fingerprinting inputs', () => {
  const navigatorImpl = {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 CriOS/142.0.0 Mobile/15E148 Safari/604.1',
  };
  expect(deviceFeatures({ navigatorImpl, standalone: false })).toEqual({
    os: 'iPhone · iOS',
    browser: 'Chrome 142',
    app: 'browser',
  });
  expect(
    deviceFeatures({ navigatorImpl: { ...navigatorImpl, standalone: true }, standalone: false })
      .app,
  ).toBe('standalone');
});
it('labels the native iPhone app without storing its user-agent string', () => {
  const navigatorImpl = {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 YuGoPi-iOS',
  };
  expect(deviceFeatures({ navigatorImpl, standalone: false })).toEqual({
    os: 'iPhone · iOS',
    browser: 'YuGo Pi',
    app: 'standalone',
  });
});

it.each([
  ['Linux; Android 15', 'Android', 'Android'],
  ['Windows NT 10.0', 'Desktop', 'Windows'],
  ['Macintosh; Intel Mac OS X 15_0', 'Desktop', 'Mac · macOS'],
])('labels the YuGo Pi client running on %s', (platform, client, os) => {
  const navigatorImpl = {
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 Chrome/142.0.0 YuGoPi-${client}`,
  };
  expect(deviceFeatures({ navigatorImpl, standalone: false })).toEqual({
    os,
    browser: 'YuGo Pi',
    app: 'standalone',
  });
});

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

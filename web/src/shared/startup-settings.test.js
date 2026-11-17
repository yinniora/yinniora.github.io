import { afterEach, expect, it, vi } from 'vitest';
import { prepareStartupSettings } from './startup-settings.js';
import zh from './locales/zh.js';
import { t, resetI18n, LOCALE_KEY } from './i18n.js';

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  resetI18n();
});

it('uses the shared language before rendering on a fresh origin', async () => {
  localStorage.clear();
  resetI18n();
  expect(t('hub.connections')).toBe('Connections');
  await prepareStartupSettings({
    fetchImpl: async () => new Response(JSON.stringify({ settings: { [LOCALE_KEY]: 'zh' } })),
  });
  expect(localStorage.getItem(LOCALE_KEY)).toBe('zh');
  expect(t('hub.connections')).toBe(zh['hub.connections']);
});

it('replaces a stale English cache when switching origins', async () => {
  localStorage.setItem(LOCALE_KEY, 'en');
  resetI18n();
  t('hub.connections');
  await prepareStartupSettings({
    fetchImpl: async () => new Response(JSON.stringify({ settings: { [LOCALE_KEY]: 'zh' } })),
  });
  expect(t('hub.trash')).toBe(zh['hub.trash']);
});

it('does not block startup indefinitely when settings are unreachable', async () => {
  vi.useFakeTimers();
  const pending = prepareStartupSettings({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(await pending).toBeNull();
});

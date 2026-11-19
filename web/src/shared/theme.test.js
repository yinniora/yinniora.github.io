import { describe, expect, it } from 'vitest';
import { applyTheme, toggleTheme, watchSystemTheme } from './theme.js';

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function fakeDocument() {
  const root = { dataset: {}, style: {} };
  const meta = { content: '' };
  return {
    documentElement: root,
    cookie: '',
    querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? meta : null),
    _meta: meta,
  };
}

describe('theme helpers', () => {
  it('applies and persists the custom theme selection', () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = { localStorage: storage, navigator: {} };

    applyTheme(windowImpl, documentImpl, 'custom');

    expect(documentImpl.documentElement.dataset.theme).toBe('custom');
    expect(storage.getItem('pi-web-theme')).toBe('custom');
    expect(documentImpl.cookie).toContain('pi-web-theme=custom');
  });

  it('uses the custom theme --body-bg for the page surround', () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = {
      localStorage: storage,
      navigator: {},
      getComputedStyle: () => ({ getPropertyValue: () => '  #1a1b26  ' }),
    };

    applyTheme(windowImpl, documentImpl, 'custom');

    expect(documentImpl.documentElement.style.backgroundColor).toBe('#1a1b26');
    expect(documentImpl._meta.content).toBe('#1a1b26');
  });

  it('falls back to the dark background when custom defines no --body-bg', () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = {
      localStorage: storage,
      navigator: {},
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
    };

    applyTheme(windowImpl, documentImpl, 'custom');

    expect(documentImpl.documentElement.style.backgroundColor).toBe('#111116');
  });

  it('cycles from dracula to custom', () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = { localStorage: storage, navigator: {} };
    documentImpl.documentElement.dataset.theme = 'dracula';

    toggleTheme(windowImpl, documentImpl);

    expect(documentImpl.documentElement.dataset.theme).toBe('custom');
    expect(storage.getItem('pi-web-theme')).toBe('custom');
  });

  it('follows the system only when the saved preference is System', () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const media = Object.assign(new EventTarget(), { matches: false });
    const windowImpl = Object.assign(new EventTarget(), {
      localStorage: storage,
      navigator: {},
      matchMedia: () => media,
    });
    watchSystemTheme(windowImpl, documentImpl);
    applyTheme(windowImpl, documentImpl, 'system');
    expect(documentImpl.documentElement.dataset.theme).toBe('light');
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(documentImpl.documentElement.dataset.theme).toBe('dark');
    expect(storage.getItem('pi-web-theme')).toBe('system');
    media.matches = false;
    windowImpl.dispatchEvent(new Event('pageshow'));
    expect(documentImpl.documentElement.dataset.theme).toBe('light');

    applyTheme(windowImpl, documentImpl, 'nord');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(documentImpl.documentElement.dataset.theme).toBe('nord');
  });
});

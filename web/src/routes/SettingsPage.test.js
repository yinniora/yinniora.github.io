import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SettingsPage from './SettingsPage.svelte';
import { t } from '../shared/i18n.js';
import { CHAT_RUNNING_SEND_MODE_KEY, resetSettingsSyncForTests } from '../shared/settings-store.js';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/settings');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetSettingsSyncForTests();
});

function activeNav() {
  return document.querySelector('.settings-sidebar-item.active')?.getAttribute('data-settings-nav');
}

describe('SettingsPage tab persistence', () => {
  it('defaults to the appearance tab when no section is in the URL', async () => {
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('appearance');
  });

  it('restores the active tab from the ?section= query param on mount', async () => {
    window.history.replaceState({}, '', '/settings?section=about');
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('about');
  });

  it('falls back to the default tab for an unknown section param', async () => {
    window.history.replaceState({}, '', '/settings?section=bogus');
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('appearance');
  });

  it('writes the selected tab to the URL so a refresh restores it', async () => {
    render(SettingsPage);
    await tick();

    await fireEvent.click(document.querySelector('[data-settings-nav="notifications"]'));
    await tick();

    expect(window.location.search).toBe('?section=notifications');
    expect(activeNav()).toBe('notifications');
  });

  it('updates the URL without adding history entries when switching tabs', async () => {
    render(SettingsPage);
    await tick();
    const lengthBefore = window.history.length;

    await fireEvent.click(document.querySelector('[data-settings-nav="language"]'));
    await tick();
    await fireEvent.click(document.querySelector('[data-settings-nav="about"]'));
    await tick();

    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.search).toBe('?section=about');
  });
});

it('saves the default send behavior from the conversation settings', async () => {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    json: async () => ({ settings: {} }),
  }));
  vi.stubGlobal('fetch', fetchImpl);
  window.history.replaceState({}, '', '/settings?section=sessionDisplay');
  const { findByRole } = render(SettingsPage);
  const select = await findByRole('combobox', { name: t('settings.runningSendMode') });
  expect(select.value).toBe('steer');
  await fireEvent.change(select, { target: { value: 'queue' } });

  expect(localStorage.getItem(CHAT_RUNNING_SEND_MODE_KEY)).toBe('queue');
  expect(fetchImpl).toHaveBeenCalledWith(
    '/api/settings',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ settings: { [CHAT_RUNNING_SEND_MODE_KEY]: 'queue' } }),
    }),
  );
});

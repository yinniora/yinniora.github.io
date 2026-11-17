import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import CommandMenu from './CommandMenu.svelte';
import { sessionModals, resetSessionModals } from '../../session/session-modals.svelte.js';
import { setSessionPaletteApi } from '../../shared/command-palette-runtime.js';
import { sessionTitle } from '../../session/session-title.svelte.js';

// The menu button (#command-menu-btn) lives in SessionHeader; the menu reads it
// by id, so the test provides it. The session name now flows through the shared
// reactive store, seeded here.
beforeEach(() => {
  document.body.innerHTML = '';
  const btn = document.createElement('button');
  btn.id = 'command-menu-btn';
  document.body.appendChild(btn);
  sessionTitle.name = 'Old';
  window.matchMedia = vi.fn(() => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSessionModals();
  setSessionPaletteApi(null);
});

describe('CommandMenu', () => {
  it('opens unified session management with the current title', async () => {
    const opened = vi.fn();
    window.addEventListener('pi:hub', opened);
    render(CommandMenu, { props: { sessionId: 'session.jsonl' } });
    await tick();
    await fireEvent.click(document.querySelector('[data-action="manage"]'));
    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0][0].detail).toEqual({
      view: 'session',
      id: 'session.jsonl',
      name: 'Old',
    });
    window.removeEventListener('pi:hub', opened);
  });

  it('closes the actions menu before navigating to /schedules', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    render(CommandMenu, { props: { sessionId: 's' } });
    await tick();

    const menuBtn = document.getElementById('command-menu-btn');
    await fireEvent.click(menuBtn);
    expect(menuBtn.getAttribute('aria-expanded')).toBe('true');

    const link = document.querySelector('#command-menu-popover a[href="/schedules"]');
    expect(link).toBeTruthy();
    expect(link.textContent).toContain('Schedules');

    await fireEvent.click(link);
    expect(pushState).toHaveBeenCalledWith({ back: '/' }, '', '/schedules');
    expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens model usage via the modal store + the session-list palette runtime', async () => {
    const openPalette = vi.fn();
    render(CommandMenu, { props: { sessionId: 's' } });
    await tick();
    setSessionPaletteApi({ open: openPalette });

    await fireEvent.click(document.querySelector('[data-action="model-usage"]'));
    await fireEvent.click(document.querySelector('[data-action="list-sessions"]'));
    expect(sessionModals.modelUsage).toBe(true);
    expect(openPalette).toHaveBeenCalled();
  });
});

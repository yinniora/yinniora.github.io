import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import HubPanel from './HubPanel.svelte';

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(detail) {
  window.dispatchEvent(new CustomEvent('pi:hub', { detail }));
  await tick();
}

it('renames a session and provides an authenticated Markdown download', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  );
  const view = render(HubPanel);
  await open({ view: 'session', id: 'test.jsonl', name: 'Before' });
  await fireEvent.input(view.getByLabelText('Session name'), { target: { value: 'After' } });
  expect(
    view.getByRole('link', { name: 'Export conversation as Markdown' }).getAttribute('href'),
  ).toBe('/api/export-markdown?id=test.jsonl');
  await fireEvent.click(view.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/rename-session?id=test.jsonl',
      expect.objectContaining({ body: JSON.stringify({ name: 'After' }) }),
    ),
  );
});

it('requires a second action before permanent deletion and allows cancellation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url, options) =>
        new Response(
          JSON.stringify(
            options?.method === 'POST'
              ? { ok: true }
              : {
                  sessions: [
                    {
                      id: 'trash.jsonl',
                      name: 'Delete me',
                      project: '/tmp',
                      deletedAt: '2026-11-17T00:00:00Z',
                    },
                  ],
                },
          ),
        ),
    ),
  );
  const view = render(HubPanel);
  await open({ view: 'trash' });
  await waitFor(() => expect(view.getByText('Delete me')).toBeTruthy());
  await fireEvent.click(view.getByRole('button', { name: 'Delete permanently' }));
  expect(fetch).toHaveBeenCalledTimes(1);
  await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  expect(fetch).toHaveBeenCalledTimes(1);
  await fireEvent.click(view.getByRole('button', { name: 'Delete permanently' }));
  await fireEvent.click(view.getByRole('button', { name: 'Confirm permanent deletion' }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/trash',
      expect.objectContaining({
        body: JSON.stringify({ id: 'trash.jsonl', restore: false, permanent: true }),
      }),
    ),
  );
});

it('keeps the error visible if a task is still running', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Stop the running task first.' }), { status: 409 }),
    ),
  );
  const view = render(HubPanel);
  await open({ view: 'session', id: 'busy.jsonl', name: 'Busy' });
  await fireEvent.click(view.getByRole('button', { name: 'Move to Trash' }));
  await waitFor(() =>
    expect(view.getByRole('alert').textContent).toBe('Stop the running task first.'),
  );
  expect(document.querySelector('dialog').open).toBe(true);
});

it('offers permanent deletion directly in the session panel with confirmation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  );
  const view = render(HubPanel);
  await open({ view: 'session', id: 'test.jsonl', name: 'Disposable test' });
  await fireEvent.click(view.getByRole('button', { name: 'Delete permanently' }));
  expect(fetch).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Confirm permanent deletion' })).toBeTruthy();
  await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  expect(fetch).not.toHaveBeenCalled();
});

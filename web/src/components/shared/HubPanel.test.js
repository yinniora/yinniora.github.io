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

it('switches transport modes on the same phone entry instead of disabling every same-origin link', async () => {
  const reconnect = vi.fn().mockResolvedValue();
  vi.stubGlobal('__PI_REMOTE_CLIENT__', { preference: 'auto', reconnect });
  const url = location.origin;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path, options) =>
        new Response(
          JSON.stringify(
            options?.method === 'POST'
              ? { clientManaged: true, transport: 'remote' }
              : {
                  connections: [
                    { id: 'auto', kind: 'auto', url },
                    { id: 'p2p', kind: 'tailscale', url },
                    { id: 'relay', kind: 'remote', url },
                  ],
                },
          ),
        ),
    ),
  );
  const view = render(HubPanel);
  await open({ view: 'connections' });
  const relay = await view.findByRole('button', { name: /^Relay/ });
  expect(relay.disabled).toBe(false);
  await fireEvent.click(relay);
  await waitFor(() => expect(reconnect).toHaveBeenCalledWith('vps'));
});

it('defaults file cleanup off and requires confirmation before deleting only selected files', async () => {
  const files = [
    { path: 'output.svg', size: 20, digest: 'digest1' },
    { path: 'notes.txt', size: 10, digest: 'digest2' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path, options) =>
        new Response(JSON.stringify(options?.method === 'POST' ? { ok: true } : { files })),
    ),
  );
  const view = render(HubPanel);
  await open({ view: 'session', id: 'owned.jsonl' });
  expect(fetch).not.toHaveBeenCalled();
  const include = view.getByLabelText('Also delete files created by this conversation');
  expect(include.checked).toBe(false);
  await fireEvent.click(include);
  await view.findByText('output.svg');
  await fireEvent.click(view.getByLabelText(/notes.txt/));
  await fireEvent.click(view.getByRole('button', { name: 'Move to Trash' }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(view.getByText(/Permanently delete the 1 selected/)).toBeTruthy();
  await fireEvent.click(
    view.getByRole('button', { name: 'Delete conversation and selected files' }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/trash',
      expect.objectContaining({
        body: JSON.stringify({
          id: 'owned.jsonl',
          restore: false,
          permanent: false,
          files: [files[0]],
          confirmFiles: true,
        }),
      }),
    ),
  );
});

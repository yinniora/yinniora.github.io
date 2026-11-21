import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import RemoteSettings from './RemoteSettings.svelte';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('imports a private server config, saves only on explicit authentication action, and clears credentials afterward', async () => {
  const settings = {
    serverUrl: 'https://old.example',
    room: 'old-room',
    hasHostToken: true,
    hasTurnSecret: true,
    hasClientSecret: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url, options) =>
        new Response(
          JSON.stringify(
            options?.method === 'POST'
              ? { ok: true, settings: { ...settings, serverUrl: 'https://own.example' } }
              : { enabled: true, settings },
          ),
        ),
    ),
  );
  const view = render(RemoteSettings);
  await waitFor(() =>
    expect(view.getByLabelText('Your relay server address').value).toBe(settings.serverUrl),
  );
  const profile = {
    serverUrl: 'https://own.example',
    room: 'r'.repeat(32),
    hostToken: 'h'.repeat(64),
    clientSecret: 'c'.repeat(64),
    turnSecret: 't'.repeat(64),
  };
  await fireEvent.click(view.getByText('Import server connection settings'));
  await fireEvent.input(view.getByLabelText('Private server connection configuration'), {
    target: { value: JSON.stringify(profile) },
  });
  await fireEvent.click(view.getByRole('button', { name: 'Import configuration' }));
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  await fireEvent.click(view.getByRole('button', { name: 'Authenticate, verify and save' }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true),
  );
  expect(
    JSON.parse(fetch.mock.calls.find(([, options]) => options?.method === 'POST')[1].body),
  ).toEqual(profile);
  await waitFor(() => expect(view.getByLabelText('Host-to-relay credential').value).toBe(''));
  expect(localStorage.length).toBe(0);
});

it('uses an explicit click to activate Tailscale and shows the required approval link', async () => {
  const fetchImpl = vi.fn(async (_, options) =>
    Response.json(
      options.method === 'POST'
        ? { consentUrl: 'https://login.tailscale.com/f/serve?node=test' }
        : {
            enabled: true,
            settings: { privateSetupAvailable: true, privateNetworkDetected: true },
          },
    ),
  );
  vi.stubGlobal('fetch', fetchImpl);
  const view = render(RemoteSettings);
  const enable = await view.findByRole('button', { name: 'Enable Tailscale connection' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await fireEvent.click(enable);
  const link = await view.findByRole('link', { name: 'Open Tailscale approval' });
  expect(link).toHaveAttribute('href', 'https://login.tailscale.com/f/serve?node=test');
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ action: 'tailscale' });
});

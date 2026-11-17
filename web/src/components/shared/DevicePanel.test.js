import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import DevicePanel from './DevicePanel.svelte';
const phone = {
  id: 'aabbcc1122334455',
  name: 'iPhone',
  createdAt: '2026-11-17T12:34:56Z',
  lastSeen: '2026-11-17T13:34:57Z',
  connected: true,
  features: { os: 'iOS 26.1', browser: 'Safari 26', app: 'standalone' },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('distinguishes same-named devices with full timestamps, features and key IDs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            enabled: true,
            canManage: true,
            devices: [phone, { ...phone, id: 'ddeeff1122334455', features: { app: 'browser' } }],
          }),
        ),
    ),
  );
  const view = render(DevicePanel);
  window.dispatchEvent(new Event('pi:devices'));
  await waitFor(() =>
    expect(view.getByText('iOS 26.1 · Safari 26 · Home Screen app')).toBeTruthy(),
  );
  expect(view.getByText('aabbcc112233')).toBeTruthy();
  expect(view.getByText('ddeeff112233')).toBeTruthy();
  expect(view.container.querySelector('time[datetime="2026-11-17T12:34:56Z"]').textContent).toMatch(
    /34:56/,
  );
});
it('removes a device after the second action and keeps it gone if refresh fails', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') return new Response('{"ok":true}');
      if (++reads > 1) throw new Error('offline');
      return new Response(
        JSON.stringify({
          enabled: true,
          canManage: true,
          devices: [phone, { ...phone, id: 'revoked', revokedAt: '2026-11-17T14:00:00Z' }],
        }),
      );
    }),
  );
  const view = render(DevicePanel);
  window.dispatchEvent(new Event('pi:devices'));
  const remove = await view.findByRole('button', { name: 'Remove device iPhone aabbcc112233' });
  expect(view.queryByText('revoked')).toBeNull();
  await fireEvent.click(remove);
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  await fireEvent.click(view.getByRole('button', { name: 'Remove and disconnect' }));
  await waitFor(() => expect(view.queryByText('aabbcc112233')).toBeNull());
  expect(fetch).toHaveBeenCalledWith(
    '/api/devices',
    expect.objectContaining({ body: JSON.stringify({ action: 'delete', id: phone.id }) }),
  );
  expect((await view.findByRole('alert')).textContent).toContain('device was removed');
});

it('ignores a stale poll response that arrives after device removal', async () => {
  let poll,
    resolveOld,
    reads = 0;
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, ms, ...args) => {
    if (ms === 5000) poll = callback;
    return interval(callback, ms, ...args);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (url === '/api/remote-settings') return new Response('{"enabled":false}');
      if (options?.method === 'POST') return new Response('{"ok":true}');
      if (++reads === 2)
        return new Promise(
          (resolve) =>
            (resolveOld = () =>
              resolve(
                new Response(JSON.stringify({ enabled: true, canManage: true, devices: [phone] })),
              )),
        );
      return new Response(
        JSON.stringify({ enabled: true, canManage: true, devices: reads === 1 ? [phone] : [] }),
      );
    }),
  );
  const view = render(DevicePanel);
  window.dispatchEvent(new Event('pi:devices'));
  const remove = await view.findByRole('button', { name: 'Remove device iPhone aabbcc112233' });
  poll();
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  await fireEvent.click(remove);
  await fireEvent.click(view.getByRole('button', { name: 'Remove and disconnect' }));
  await waitFor(() => expect(view.queryByText('aabbcc112233')).toBeNull());
  resolveOld();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(view.queryByText('aabbcc112233')).toBeNull();
});

import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import RemoteConnect from './RemoteConnect.svelte';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('provides scanning, paste and all transport choices when this app has no pairing record', () => {
  const { getByRole, getByLabelText } = render(RemoteConnect, { props: { onConnect: vi.fn() } });
  expect(getByRole('button', { name: 'Scan QR code' })).toBeTruthy();
  expect(getByLabelText('Pairing link')).toBeTruthy();
  for (const name of ['Automatic', 'Tailscale', 'VPS'])
    expect(getByRole('radio', { name })).toBeTruthy();
});
it('can pair inside the current app using a copied Mac link', async () => {
  vi.stubGlobal('location', new URL('https://pi.example/'));
  const config = {
    version: 1,
    fingerprint: Array(32).fill('ab').join(':'),
    clientUrl: 'https://pi.example/',
    signalUrl: 'wss://relay.example/signal',
    iceUrl: 'https://relay.example/ice',
    ticket: 'f'.repeat(64),
  };
  const onConnect = vi.fn().mockResolvedValue();
  const { getByRole, getByLabelText } = render(RemoteConnect, { props: { onConnect } });
  await fireEvent.input(getByLabelText('Pairing link'), {
    target: { value: 'https://pi.example/#pair=' + btoa(JSON.stringify(config)) },
  });
  await fireEvent.click(getByRole('button', { name: 'Pair and connect' }));
  await waitFor(() =>
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: config.ticket }),
      'auto',
    ),
  );
});
it('offers a usable paste fallback when camera permission is unavailable', async () => {
  const mediaDevices = { getUserMedia: vi.fn().mockRejectedValue(new Error('permission denied')) };
  const { getByRole, getByLabelText } = render(RemoteConnect, {
    props: { onConnect: vi.fn(), mediaDevices },
  });
  await fireEvent.click(getByRole('button', { name: 'Scan QR code' }));
  await waitFor(() => expect(getByRole('alert').textContent).toContain('camera is unavailable'));
  expect(getByLabelText('Pairing link')).toBeTruthy();
  expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
});

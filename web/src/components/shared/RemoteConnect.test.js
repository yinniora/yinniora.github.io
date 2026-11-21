import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import RemoteConnect from './RemoteConnect.svelte';
import { TRANSPORT_KEY } from '../../remote/config.js';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('offers scanning and paste without asking about transport before pairing', () => {
  const { getByRole, getByLabelText, queryAllByRole } = render(RemoteConnect, {
    props: { onConnect: vi.fn() },
  });
  expect(getByRole('button', { name: 'Scan QR code' })).toBeTruthy();
  expect(getByLabelText('Pairing link')).toBeTruthy();
  expect(queryAllByRole('radio')).toHaveLength(0);
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
      expect.any(Function),
    ),
  );
});
it('connects via a pure private route even when an old relay preference was stored', async () => {
  localStorage.setItem(TRANSPORT_KEY, 'vps');
  const config = { directUrl: 'wss://host.tail.example/remote-signal' };
  const onConnect = vi.fn().mockResolvedValue();
  const { queryAllByRole } = render(RemoteConnect, { props: { onConnect, initialConfig: config } });
  await waitFor(() => expect(onConnect).toHaveBeenCalledWith(config, 'auto', expect.any(Function)));
  expect(queryAllByRole('radio')).toHaveLength(0);
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
it('opens the native iPhone scanner before requesting browser camera access', async () => {
  const postMessage = vi.fn();
  const mediaDevices = { getUserMedia: vi.fn() };
  vi.stubGlobal('webkit', { messageHandlers: { yugoNativeScanner: { postMessage } } });
  const { getByRole } = render(RemoteConnect, { props: { onConnect: vi.fn(), mediaDevices } });
  await fireEvent.click(getByRole('button', { name: 'Scan QR code' }));
  expect(postMessage).toHaveBeenCalledWith('scan');
  expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

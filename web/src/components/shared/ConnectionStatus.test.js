import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import ConnectionStatus from './ConnectionStatus.svelte';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('shows actual transport status and brief sync/loading states', async () => {
  const client = new EventTarget();
  client.status = 'connected';
  const view = render(ConnectionStatus, { props: { client } });
  expect(view.getByRole('status').textContent).toContain('Connected');
  for (const [state, label] of [
    ['syncing', 'Syncing'],
    ['loading', 'Loading'],
    ['reconnecting', 'Reconnecting'],
    ['disconnected', 'Disconnected'],
    ['blocked', 'Pair again'],
  ]) {
    client.status = state;
    client.dispatchEvent(new CustomEvent('status', { detail: state }));
    await waitFor(() => expect(view.getByRole('status').textContent).toContain(label));
  }
});

it('shows only P2P or relay, without exposing private network product names', async () => {
  const client = new EventTarget();
  client.status = 'connected';
  client.transport = 'p2p';
  const view = render(ConnectionStatus, { props: { client } });
  expect(view.getByRole('status').textContent).toContain('P2P');
  client.transport = 'relay';
  client.dispatchEvent(new CustomEvent('status', { detail: 'connected' }));
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('Relay'));
  expect(view.getByRole('status').textContent).not.toContain('Tailscale');
});

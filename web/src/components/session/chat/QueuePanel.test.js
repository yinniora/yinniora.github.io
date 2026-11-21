import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueuePanel from './QueuePanel.svelte';
import { QueueStore } from './queue-store.svelte.js';

afterEach(() => {
  cleanup();
});

function steerStore(texts = ['polish the header']) {
  const store = new QueueStore();
  for (const text of texts) store.pushSteer({ text, detail: { cancelBeforeSend: () => true } });
  return store;
}

describe('QueuePanel', () => {
  it('renders nothing while both the queue and the steer list are empty', () => {
    render(QueuePanel, { props: { store: new QueueStore() } });
    expect(document.querySelector('.pi-queue-panel')).toBeNull();
  });

  it('labels the edit, queue, withdraw and immediate send actions until dispatch', async () => {
    const store = steerStore();
    const queueSteer = vi.fn();
    const editSteer = vi.fn();
    const withdrawSteer = vi.fn();
    const sendNow = vi.fn();
    store.items[0].detail.sendNow = sendNow;
    store.actions.queueSteer = queueSteer;
    store.actions.editSteer = editSteer;
    store.actions.withdrawSteer = withdrawSteer;
    render(QueuePanel, { props: { store } });

    const row = document.querySelector('.pi-queue-item--steer');
    expect(row.querySelector('.pi-queue-item-text').textContent).toBe('polish the header');
    expect(row.querySelector('.pi-queue-item-icon svg')).not.toBeNull();

    const card = within(row);
    card.getByRole('button', { name: 'Edit', exact: true }).click();
    card.getByRole('button', { name: 'Move to queue', exact: true }).click();
    card.getByRole('button', { name: 'Withdraw', exact: true }).click();
    card.getByRole('button', { name: 'Send now', exact: true }).click();

    const id = store.items[0].id;
    expect(editSteer).toHaveBeenCalledWith(id);
    expect(queueSteer).toHaveBeenCalledWith(id);
    expect(withdrawSteer).toHaveBeenCalledWith(id);
    expect(sendNow).toHaveBeenCalledTimes(1);

    store.items[0].editable = false;
    await tick();
    expect(card.queryAllByRole('button')).toHaveLength(0);
    expect(card.getByText('Waiting for Pi to pick up')).toBeTruthy();
  });

  it('labels the two groups only when both are present', () => {
    const store = new QueueStore();
    store.items = [
      { id: 'q-1', kind: 'queued', position: 1, text: 'later', displayText: 'later' },
      { id: 's-1', kind: 'steer', text: 'now', displayText: 'now' },
    ];
    render(QueuePanel, { props: { store } });

    const labels = [...document.querySelectorAll('.pi-queue-section-label')].map((el) =>
      el.textContent.trim(),
    );
    expect(labels).toEqual(['Queue', 'steering']);
    expect(document.querySelectorAll('.pi-queue-item--steer')).toHaveLength(1);
    expect(
      document.querySelectorAll('.pi-queue-list .pi-queue-item:not(.pi-queue-item--steer)'),
    ).toHaveLength(1);
  });
});

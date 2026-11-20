import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
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

  it('gives every steer row edit, move-to-queue and withdraw actions', async () => {
    const store = steerStore();
    const queueSteer = vi.fn();
    const editSteer = vi.fn();
    const withdrawSteer = vi.fn();
    store.actions.queueSteer = queueSteer;
    store.actions.editSteer = editSteer;
    store.actions.withdrawSteer = withdrawSteer;
    render(QueuePanel, { props: { store } });

    const row = document.querySelector('.pi-queue-item--steer');
    expect(row.querySelector('.pi-queue-item-text').textContent).toBe('polish the header');
    expect(row.querySelector('.pi-queue-item-tag').textContent).toBe('steering');

    const [edit, toQueue, withdraw] = row.querySelectorAll('.pi-queue-item-action');
    await edit.click();
    await toQueue.click();
    await withdraw.click();

    const id = store.items[0].id;
    expect(editSteer).toHaveBeenCalledWith(id);
    expect(queueSteer).toHaveBeenCalledWith(id);
    expect(withdrawSteer).toHaveBeenCalledWith(id);
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

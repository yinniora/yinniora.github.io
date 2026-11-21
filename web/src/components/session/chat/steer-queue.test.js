import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSteerQueue } from './steer-queue.js';
import { QueueStore } from './queue-store.svelte.js';

function makeDom() {
  document.body.innerHTML = `
    <button id="queue" type="button" disabled></button>
    <textarea id="textarea"></textarea>
  `;
  return {
    queueButton: document.getElementById('queue'),
    textarea: document.getElementById('textarea'),
  };
}

function makeApi(initial = { items: [], paused: false }) {
  let next = 1;
  const items = [...initial.items];
  let paused = !!initial.paused;
  return {
    list: vi.fn(async () => ({ items: [...items], paused })),
    add: vi.fn(async (message, displayText) => {
      const item = { sessionId: 'mock', position: next++, message, displayText };
      items.push(item);
      return item;
    }),
    remove: vi.fn(async (position) => {
      for (let i = 0; i < items.length; i++) {
        if (items[i].position === position) {
          items.splice(i, 1);
          return;
        }
      }
    }),
    setPaused: vi.fn(async (value) => {
      paused = !!value;
    }),
  };
}

function type(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('setupSteerQueue (server-backed)', () => {
  it('queue button is disabled until the textarea has content', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    setupSteerQueue({ store, queueButton, textarea });

    expect(queueButton.disabled).toBe(true);
    type(textarea, 'hello');
    expect(queueButton.disabled).toBe(false);
  });

  it('clicking queue POSTs to the api and adds the new row to the store', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueButton, textarea, queueApi: api });

    type(textarea, 'hello');
    queueButton.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.add).toHaveBeenCalledWith('hello', 'hello');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ kind: 'queued', text: 'hello' });
    expect(textarea.value).toBe('');
  });

  it('restores the failed queue draft and attachments without overwriting newer text', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    let rejectAdd;
    api.add.mockImplementationOnce(() => new Promise((_, reject) => (rejectAdd = reject)));
    const store = new QueueStore({ api });
    const file = new File(['data'], 'notes.txt');
    const attachments = {
      files: vi.fn().mockReturnValueOnce([file]).mockReturnValueOnce([file]).mockReturnValue([]),
      composeMessage: (text) => text,
      clear: vi.fn(),
      restore: vi.fn(),
    };
    const handle = setupSteerQueue({ store, queueButton, textarea, queueApi: api, attachments });
    textarea.value = 'original';
    const pending = handle.enqueueFromComposer();
    textarea.value = 'newer';
    rejectAdd(new Error('rejected'));
    expect(await pending).toBe(false);
    expect(textarea.value).toBe('original\n\nnewer');
    expect(attachments.restore).toHaveBeenCalledWith({ files: [file], textAttachments: [] });
    handle.dispose();
  });

  it('subsequent sends during an active run produce steer rows in the store', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    setupSteerQueue({ store, queueButton, textarea });

    // First send: run starts. No steer.
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    expect(store.steerCount).toBe(0);

    // Subsequent send: steer.
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer-msg' } }),
    );
    expect(store.steerCount).toBe(1);
    expect(store.items[0].text).toBe('steer-msg');

    // Steer is removable without touching the api.
    store.removeById(store.items[0].id);
    expect(store.steerCount).toBe(0);
  });

  it('worker-done clears steer rows but does not auto-dispatch (server drainer handles that)', () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    const sendChatMessage = vi.fn(async () => true);
    setupSteerQueue({ store, queueButton, textarea, sendChatMessage, queueApi: api });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    window.dispatchEvent(new Event('pi-worker-done'));
    expect(store.steerCount).toBe(0);
    // Frontend does NOT dispatch on its own — the server drainer is responsible.
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it('sendNow waits for acknowledgement from the queue endpoint before removing the item', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    api.sendNow = vi
      .fn()
      .mockRejectedValueOnce(new Error('session is busy'))
      .mockResolvedValueOnce({ ok: true });
    const handle = setupSteerQueue({
      store,
      queueButton,
      textarea,
      queueApi: api,
    });

    type(textarea, 'queue-me');
    queueButton.click();
    // Wait for enqueue Promise + store update.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.queuedCount).toBe(1);

    const id = store.items[0].id;
    await handle.sendNow(id);
    expect(store.queuedCount).toBe(1);
    await handle.sendNow(id);
    expect(api.sendNow).toHaveBeenCalledWith(1);
    expect(api.remove).not.toHaveBeenCalled();
    expect(store.queuedCount).toBe(0);
  });

  it('edit DELETEs the row server-side and pops the text back into the textarea', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    const handle = setupSteerQueue({ store, queueButton, textarea, queueApi: api });

    type(textarea, 'draft');
    queueButton.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.queuedCount).toBe(1);

    await handle.edit(store.items[0].id);
    expect(api.remove).toHaveBeenCalled();
    expect(textarea.value).toBe('draft');
    expect(store.queuedCount).toBe(0);
  });

  it('clears a steer chip when a matching user entry appears on session reload', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
      queueButton,
      textarea,
      getLiveEntries: () => entries,
    });

    // Start an active run, then a steer.
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', { detail: { message: 'sorry, continue' } }),
    );
    expect(store.steerCount).toBe(1);

    // pi has now folded the steer in and the session JSONL has a user entry.
    entries.push({
      id: 'u1',
      type: 'message',
      message: { role: 'user', content: 'sorry, continue' },
    });
    window.dispatchEvent(new Event('pi-session-reload'));

    expect(store.steerCount).toBe(0);
  });

  it('FIFO-clears a steer chip when a new user entry lands but its text does not match', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
      queueButton,
      textarea,
      getLiveEntries: () => entries,
    });

    // Seed initial user-count baseline (so the listener doesn't fire on the
    // first reload thinking historical messages are fresh).
    window.dispatchEvent(new Event('pi-session-reload'));

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    // pi has folded the steer in but its stored content is decorated, so the
    // exact-text matcher misses. The FIFO fallback still pops the head steer.
    entries.push({
      id: 'u1',
      type: 'message',
      message: { role: 'user', content: '[steer] steer (with cwd context)' },
    });
    window.dispatchEvent(new Event('pi-session-reload'));

    expect(store.steerCount).toBe(0);
  });

  it('clears a steer chip that lands right after a compaction shrank the projection', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const user = (id, content) => ({ id, type: 'message', message: { role: 'user', content } });
    let entries = [user('old1', 'a'), user('old2', 'b'), user('old3', 'c')];
    setupSteerQueue({ store, queueButton, textarea, getLiveEntries: () => entries });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', { detail: { message: 'polish' } }),
    );
    expect(store.steerCount).toBe(1);

    // Compaction leaves fewer user entries than before, plus the steer with
    // an image note appended.
    entries = [user('new', 'polish\n\n[Image: 1206x2622]')];
    window.dispatchEvent(new Event('pi-session-reload'));
    expect(store.steerCount).toBe(0);
  });

  it('leaves the steer chip alone while no matching user entry has landed', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
      queueButton,
      textarea,
      getLiveEntries: () => entries,
    });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'task' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    // Reload fires but the steer hasn't been picked up yet (no matching user entry).
    window.dispatchEvent(new Event('pi-session-reload'));
    expect(store.steerCount).toBe(1);
  });

  it('does not clear a steer when an unrelated user message is recorded', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({ store, queueButton, textarea, getLiveEntries: () => entries });
    window.dispatchEvent(new Event('pi-session-reload'));

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', { detail: { message: 'try the other file' } }),
    );
    expect(store.steerCount).toBe(1);

    entries.push({
      id: 'u1',
      type: 'message',
      message: { role: 'user', content: 'Go ahead with the second option instead.' },
    });
    window.dispatchEvent(new Event('pi-session-reload'));

    expect(store.steerCount).toBe(1);
  });

  it('clears one steer chip per landed user entry, oldest first', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({ store, queueButton, textarea, getLiveEntries: () => entries });
    window.dispatchEvent(new Event('pi-session-reload'));

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    for (const message of ['one', 'two', 'three']) {
      window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message } }));
    }
    expect(store.steerCount).toBe(3);

    entries.push({ id: 'u1', type: 'message', message: { role: 'user', content: 'one' } });
    window.dispatchEvent(new Event('pi-session-reload'));
    expect(store.steerCount).toBe(2);
    expect(store.items.filter((item) => item.kind === 'steer')[0].text).toBe('two');
  });

  it('editSteer pulls the text back into the composer and drops the chip', () => {
    const { queueButton, textarea } = makeDom();
    const store = new QueueStore();
    setupSteerQueue({
      store,
      queueButton,
      textarea,
    });
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', {
        detail: { message: 'rename the route', cancelBeforeSend: () => true, files: [] },
      }),
    );
    const id = store.items.find((item) => item.kind === 'steer').id;

    expect(store.actions.editSteer(id)).toBe(true);
    expect(store.steerCount).toBe(0);
    expect(textarea.value).toBe('rename the route');
    expect(queueButton.disabled).toBe(false);
  });

  it('withdrawSteer drops the chip without touching the api', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueButton, textarea, queueApi: api });
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', {
        detail: { message: 'stop', cancelBeforeSend: () => true, files: [] },
      }),
    );

    const id = store.items.find((item) => item.kind === 'steer').id;
    expect(store.actions.withdrawSteer(id)).toBe(true);
    expect(store.steerCount).toBe(0);
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('queueSteer re-files the steer as a server-side queued message', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueButton, textarea, queueApi: api });
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', {
        detail: { message: 'after this turn', cancelBeforeSend: () => true, files: [] },
      }),
    );

    const id = store.items.find((item) => item.kind === 'steer').id;
    await store.actions.queueSteer(id);

    expect(api.add).toHaveBeenCalledWith('after this turn', 'after this turn');
    expect(store.steerCount).toBe(0);
    expect(store.queuedCount).toBe(1);
    expect(store.items[0]).toMatchObject({ kind: 'queued', text: 'after this turn' });
  });

  it('resume PATCHes paused=false through the api', async () => {
    const { queueButton, textarea } = makeDom();
    const api = makeApi();
    const store = new QueueStore({ api });
    const handle = setupSteerQueue({ store, queueButton, textarea, queueApi: api });
    await store.setPaused(true);
    api.setPaused.mockClear();
    await handle.resume();
    expect(api.setPaused).toHaveBeenCalledWith(false);
    expect(store.paused).toBe(false);
  });
});

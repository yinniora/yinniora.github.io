import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSteerQueue } from './steer-queue.js';
import { QueueStore } from './queue-store.svelte.js';

function makeTextarea() {
  document.body.innerHTML = '<textarea id="textarea"></textarea>';
  return document.getElementById('textarea');
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

function reconcile(sessionId) {
  window.dispatchEvent(new CustomEvent('pi-session-entries-reconciled', { detail: { sessionId } }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('setupSteerQueue (server-backed)', () => {
  it('enqueuing the composer POSTs to the api and adds the new row to the store', async () => {
    const textarea = makeTextarea();
    const api = makeApi();
    const store = new QueueStore({ api });
    const handle = setupSteerQueue({ store, textarea, queueApi: api });

    textarea.value = 'hello';
    expect(await handle.enqueueFromComposer()).toBe(true);

    expect(api.add).toHaveBeenCalledWith('hello', 'hello');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ kind: 'queued', text: 'hello' });
    expect(textarea.value).toBe('');
  });

  it('restores the failed queue draft and attachments without overwriting newer text', async () => {
    const textarea = makeTextarea();
    const api = makeApi();
    let rejectAdd;
    api.add.mockImplementationOnce(() => new Promise((_, reject) => (rejectAdd = reject)));
    const store = new QueueStore({ api });
    const file = new File(['data'], 'notes.txt');
    const newerFile = new File(['data'], 'new-notes.txt');
    const attachments = {
      files: vi.fn().mockReturnValue([file]),
      composeMessage: (text) => text,
      clear: vi.fn(),
      restore: vi.fn(),
    };
    const handle = setupSteerQueue({ store, textarea, queueApi: api, attachments });
    textarea.value = 'original';
    const pending = handle.enqueueFromComposer();
    textarea.value = 'newer';
    attachments.files.mockReturnValue([newerFile]);
    rejectAdd(new Error('rejected'));
    expect(await pending).toBe(false);
    expect(textarea.value).toBe('original\n\nnewer');
    expect(attachments.restore).toHaveBeenCalledWith({
      files: [file, newerFile],
      textAttachments: [],
    });
    handle.dispose();
  });

  it('subsequent sends during an active run produce steer rows in the store', () => {
    const store = new QueueStore();
    setupSteerQueue({ store });

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
    const api = makeApi();
    api.sendNow = vi.fn();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueApi: api });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    window.dispatchEvent(new Event('pi-worker-done'));
    expect(store.steerCount).toBe(0);
    // Frontend does NOT dispatch on its own — the server drainer is responsible.
    expect(api.sendNow).not.toHaveBeenCalled();
  });

  it('preserves a staged and in-flight guide when the previous worker run finishes', () => {
    const store = new QueueStore();
    const entries = [];
    const handle = setupSteerQueue({ store, getLiveEntries: () => entries });
    const detail = {
      message: '上一轮结束后仍应发出',
      steering: true,
      cancelBeforeSend: () => true,
    };
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail }));
    window.dispatchEvent(new Event('pi-worker-done'));
    expect(store.items[0].editable).toBe(true);

    window.dispatchEvent(new CustomEvent('pi-chat-message-delivering', { detail }));
    window.dispatchEvent(new Event('pi-worker-done'));
    window.dispatchEvent(new CustomEvent('pi-chat-message-accepted', { detail }));
    window.dispatchEvent(new Event('pi-worker-done'));
    expect(store.steerCount).toBe(1);
    expect(store.items[0].editable).toBe(false);

    entries.push({
      id: 'echo',
      type: 'message',
      message: { role: 'user', content: detail.message },
    });
    reconcile();
    expect(store.steerCount).toBe(0);
    handle.dispose();
  });

  it('clears only the delivered guide whose request Pi handled without recording a message', () => {
    const store = new QueueStore();
    const handle = setupSteerQueue({ sessionId: 'current', store });
    const first = {
      requestId: 'first-id',
      message: '/command',
      steering: true,
      cancelBeforeSend: () => true,
    };
    const second = { ...first, requestId: 'second-id' };
    for (const detail of [first, second]) {
      window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail }));
    }
    window.dispatchEvent(new CustomEvent('pi-chat-message-delivering', { detail: first }));
    const handled = (sessionId, requestId) =>
      window.dispatchEvent(
        new CustomEvent('pi-chat-prompt-handled', { detail: { sessionId, requestId } }),
      );
    handled('other', first.requestId);
    handled('current', second.requestId);
    expect(store.steerCount).toBe(2);

    handled('current', first.requestId);
    expect(store.items.map((item) => item.detail?.requestId)).toEqual(['second-id']);
    handle.dispose();
  });

  it('sendNow waits for acknowledgement from the queue endpoint before removing the item', async () => {
    const textarea = makeTextarea();
    const api = makeApi();
    const store = new QueueStore({ api });
    api.sendNow = vi
      .fn()
      .mockRejectedValueOnce(new Error('session is busy'))
      .mockResolvedValueOnce({ ok: true });
    const handle = setupSteerQueue({
      store,
      textarea,
      queueApi: api,
    });

    textarea.value = 'queue-me';
    await handle.enqueueFromComposer();
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
    const textarea = makeTextarea();
    const api = makeApi();
    const store = new QueueStore({ api });
    const handle = setupSteerQueue({ store, textarea, queueApi: api });

    textarea.value = 'draft';
    await handle.enqueueFromComposer();
    expect(store.queuedCount).toBe(1);

    await handle.edit(store.items[0].id);
    expect(api.remove).toHaveBeenCalled();
    expect(textarea.value).toBe('draft');
    expect(store.queuedCount).toBe(0);
  });

  it('clears a steer chip when a matching user entry appears on session reload', () => {
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
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
    reconcile();

    expect(store.steerCount).toBe(0);
  });

  it('clears an exactly matching steer when a known legacy prefix and suffix decorate it', () => {
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
      getLiveEntries: () => entries,
    });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    entries.push({
      id: 'u1',
      type: 'message',
      message: { role: 'user', content: '[steer] steer (with cwd context)' },
    });
    reconcile();

    expect(store.steerCount).toBe(0);
  });

  it('clears a steer chip that lands right after a compaction shrank the projection', () => {
    const store = new QueueStore();
    const user = (id, content) => ({ id, type: 'message', message: { role: 'user', content } });
    let entries = [user('old1', 'a'), user('old2', 'b'), user('old3', 'c')];
    setupSteerQueue({ store, getLiveEntries: () => entries });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    window.dispatchEvent(
      new CustomEvent('pi-chat-message-sent', {
        detail: { message: 'polish', files: [new File(['fixture'], 'photo.png')] },
      }),
    );
    expect(store.steerCount).toBe(1);

    // Compaction leaves fewer user entries than before, plus the steer with
    // an image note appended.
    entries = [user('new', 'polish\n\n[Image: 1206x2622]')];
    reconcile();
    expect(store.steerCount).toBe(0);
  });

  it('leaves the steer chip alone while no matching user entry has landed', () => {
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({
      store,
      getLiveEntries: () => entries,
    });

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'task' } }));
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'steer' } }));
    expect(store.steerCount).toBe(1);

    // Reload fires but the steer hasn't been picked up yet (no matching user entry).
    reconcile();
    expect(store.steerCount).toBe(1);
  });

  it('does not clear a steer when an unrelated user message is recorded', () => {
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({ store, getLiveEntries: () => entries });
    reconcile();

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
    reconcile();

    expect(store.steerCount).toBe(1);
  });

  it('clears one steer chip per landed user entry, oldest first', () => {
    const store = new QueueStore();
    const entries = [];
    setupSteerQueue({ store, getLiveEntries: () => entries });
    reconcile();

    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message: 'first' } }));
    for (const message of ['one', 'two', 'three']) {
      window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail: { message } }));
    }
    expect(store.steerCount).toBe(3);

    entries.push({ id: 'u1', type: 'message', message: { role: 'user', content: 'one' } });
    reconcile();
    expect(store.steerCount).toBe(2);
    expect(store.items.filter((item) => item.kind === 'steer')[0].text).toBe('two');
  });

  it('clears only the scheduled copy of identical steers and ignores reloaded history', () => {
    const store = new QueueStore();
    const user = (id, timestamp) => ({
      id,
      type: 'message',
      message: { role: 'user', content: '同一条引导', timestamp },
    });
    const entries = [user('initial', 4_000)];
    const handle = setupSteerQueue({
      store,
      sessionId: 'this-session',
      getLiveEntries: () => entries,
    });
    const first = { message: '同一条引导', steering: true };
    const second = { ...first };
    for (const detail of [first, second]) {
      window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail }));
    }
    const [firstID, secondID] = store.items.map(({ id }) => id);
    entries.unshift(user('older-page', 2_000));
    reconcile('this-session');
    expect(store.items.map(({ id }) => id)).toEqual([firstID, secondID]);

    entries.push(user('new-first', 5_000));
    reconcile('unrelated-session');
    expect(store.items.map(({ id }) => id)).toEqual([firstID, secondID]);
    reconcile('this-session');
    reconcile('this-session');
    expect(store.items.map(({ id }) => id)).toEqual([secondID]);

    entries.push(user('new-second', 5_000));
    reconcile('this-session');
    expect(store.steerCount).toBe(0);
    handle.dispose();
  });

  it.each([
    {
      name: 'a file-only steer',
      draft: '',
      files: [new File(['fixture'], 'report.txt')],
      stored:
        'Files attached by the user (stored on the computer):\n- "/tmp/attachment-1/1-report.txt"',
    },
    {
      name: 'a file with text',
      draft: '看看这个文件',
      files: [new File(['fixture'], 'report.txt')],
      stored:
        '看看这个文件\n\nFiles attached by the user (stored on the computer):\n- "/tmp/attachment-1/1-report.txt"',
    },
    {
      name: 'an attached image and its leading note',
      draft: '看看这张图',
      files: [new File(['fixture'], 'photo.png', { type: 'image/png' })],
      stored: [
        { type: 'text', text: '[Image: original 1800x2000, displayed at 880x968.]\n\n看看这张图' },
        { type: 'image', mimeType: 'image/png' },
      ],
    },
    {
      name: 'an image-only steer',
      draft: '',
      files: [new File(['fixture'], 'photo.png', { type: 'image/png' })],
      stored: [
        { type: 'text', text: '' },
        { type: 'image', mimeType: 'image/png' },
      ],
    },
    {
      name: 'Pi’s expanded skill input',
      draft: '/skill:read-file details',
      files: [],
      stored:
        '<skill name="read-file" location="/tmp/SKILL.md">\nReferences are relative to /tmp.\n\nRead a file.\n</skill>\n\ndetails',
    },
  ])('clears $name only after its matching user entry is recorded', ({ draft, files, stored }) => {
    const store = new QueueStore();
    const entries = [];
    const handle = setupSteerQueue({ store, getLiveEntries: () => entries });
    const detail = { message: draft, files, steering: true, cancelBeforeSend: () => true };
    window.dispatchEvent(new CustomEvent('pi-chat-message-sent', { detail }));
    entries.push({ id: 'old', type: 'message', message: { role: 'user', content: stored } });
    reconcile();
    expect(store.steerCount).toBe(1);

    window.dispatchEvent(new CustomEvent('pi-chat-message-delivering', { detail }));
    reconcile();
    expect(store.steerCount).toBe(1);
    entries.push({ id: 'echo', type: 'message', message: { role: 'user', content: stored } });
    reconcile();
    expect(store.steerCount).toBe(0);
    handle.dispose();
  });

  it('editSteer pulls the text back into the composer and drops the chip', () => {
    const textarea = makeTextarea();
    const store = new QueueStore();
    setupSteerQueue({
      store,
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
  });

  it('withdrawSteer drops the chip without touching the api', async () => {
    const api = makeApi();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueApi: api });
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
    const api = makeApi();
    const store = new QueueStore({ api });
    setupSteerQueue({ store, queueApi: api });
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
    const api = makeApi();
    const store = new QueueStore({ api });
    const handle = setupSteerQueue({ store, queueApi: api });
    await store.setPaused(true);
    api.setPaused.mockClear();
    await handle.resume();
    expect(api.setPaused).toHaveBeenCalledWith(false);
    expect(store.paused).toBe(false);
  });
});

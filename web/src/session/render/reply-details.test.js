import { describe, expect, it } from 'vitest';
import { entriesWithReplyDetails } from './reply-details.js';

const user = (id, text) => ({
  id,
  type: 'message',
  message: { role: 'user', content: text },
});
const failed = (id, error) => ({
  id,
  type: 'message',
  message: { role: 'assistant', stopReason: 'error', errorMessage: error, content: [] },
});
const replied = (id, text) => ({
  id,
  type: 'message',
  message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] },
});

describe('entriesWithReplyDetails', () => {
  it('hides a transport failure that the retry already recovered from', () => {
    const entries = [
      user('u1', 'ship it'),
      failed('a1', 'Connection error.: Client network socket disconnected (ECONNRESET)'),
      replied('a2', 'Done — shipped.'),
    ];
    const details = entriesWithReplyDetails(entries);

    expect(details[1].retried).toBe(true);
    expect(details[1].retryContent).toBeUndefined();
    expect(details[2].reply.text).toBe('Done — shipped.');
  });

  it('keeps a failure visible when the turn really ended on it', () => {
    const entries = [user('u1', 'ship it'), failed('a1', 'Request timed out.')];
    const details = entriesWithReplyDetails(entries);

    expect(details[1].retried).toBeUndefined();
    expect(details[1].retryContent).toBe('ship it');
    expect(entriesWithReplyDetails(entries, { running: true })[1].retried).toBe(true);
  });

  it('does not reach back across turns, and recovers on tool calls too', () => {
    const entries = [
      user('u1', 'first'),
      failed('a1', 'boom'),
      user('u2', 'second'),
      failed('a2', 'Request timed out.'),
      {
        id: 'a3',
        type: 'message',
        message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall' }] },
      },
    ];
    const details = entriesWithReplyDetails(entries);

    expect(details[1].retried).toBeUndefined();
    expect(details[3].retried).toBe(true);
  });
});

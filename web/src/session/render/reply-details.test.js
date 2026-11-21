import { describe, expect, it } from 'vitest';
import { entriesWithReplyDetails, providerNetworkFailure } from './reply-details.js';

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
  it.each([
    [
      'Client network socket disconnected before secure TLS connection was established (ECONNRESET)',
      'tls',
    ],
    ['open ECONNREFUSED', 'connect'],
    ['Request timed out.', 'timeout'],
    ['Anthropic stream ended before message_stop', 'stream'],
    ['read ECONNRESET', 'transport'],
    ['503 model_not_found', ''],
    ['Request was cancelled', ''],
    ['Permission denied: timeout policy', ''],
    ['400 unsupported_compat_parameter: timeout', ''],
  ])('classifies %s as %s without inventing a failure phase', (error, stage) => {
    expect(providerNetworkFailure(error)).toBe(stage);
  });

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
    expect(details[1].canResumeNetworkFailure).toBe(true);
    expect(entriesWithReplyDetails(entries, { running: true })[1].retried).toBe(true);
  });

  it('keeps a terminal failure after an omitted retry and offers continuation only there', () => {
    const entries = [
      user('u1', 'ship it'),
      failed('a1', 'Request timed out.'),
      { id: 'omit', type: 'context_edit', targetId: 'a1', replacement: null },
      failed('a2', 'Model stream disconnected before completion'),
      { id: 'omit2', type: 'context_edit', targetId: 'a2', replacement: null },
    ];
    const details = entriesWithReplyDetails(entries);

    expect(details[1].retried).toBe(true);
    expect(details[3]).toMatchObject({ canResumeNetworkFailure: true, retryContent: 'ship it' });
    expect(details[3].retried).toBeUndefined();
    const newerTurn = [...entries, user('u2', 'new work')];
    expect(entriesWithReplyDetails(newerTurn)[3].canResumeNetworkFailure).toBe(false);
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

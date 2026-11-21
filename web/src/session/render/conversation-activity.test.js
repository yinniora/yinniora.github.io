import { describe, expect, it } from 'vitest';
import { groupConversationActivity } from './conversation-activity.js';
import { entriesWithReplyDetails } from './reply-details.js';
import { formatElapsed, formatShortTime, stripImageNotes } from './entry-format.js';

const at = (s) => new Date(Date.UTC(2026, 10, 19, 2, 0, s)).toISOString();
const msg = (id, s, message) => ({ entry: { id, type: 'message', timestamp: at(s), message } });

it('uses the same open activity and thought keys before and after a streamed message is written', () => {
  const user = msg('user', 0, { role: 'user', content: 'go' });
  const timestamp = Date.parse(at(1));
  const live = [{ messageTimestamp: timestamp, thinkingIndex: 0, thinking: 'still streaming' }];
  const [before] = groupConversationActivity([user], new Map(), true, live).filter((s) => s.items);
  const assistant = msg('saved', 1, {
    role: 'assistant',
    timestamp,
    stopReason: 'toolUse',
    content: [{ type: 'thinking', thinking: 'still streaming but now recorded' }],
  });
  const [after] = groupConversationActivity([user, assistant], new Map(), true, live).filter(
    (s) => s.items,
  );
  expect(before.running).toBe(true);
  expect(after.running).toBe(true);
  expect(after.key).toBe(before.key);
  expect(after.timeline).toHaveLength(1);
  expect(after.timeline[0]).toMatchObject({
    key: before.timeline[0].key,
    text: 'still streaming but now recorded',
  });
});

describe('conversation activity duration', () => {
  it('keeps a no-text final response visible as an unsuccessful reply', () => {
    const user = msg('u', 0, { role: 'user', content: 'go' });
    const empty = msg('empty', 4, {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'A thought without a reply.' }],
    });
    const entries = entriesWithReplyDetails([user.entry, empty.entry]);
    const sections = groupConversationActivity(entries, new Map());
    expect(sections.at(-1).item).toMatchObject({ emptyReply: true, retryContent: 'go' });
  });
  it('measures a turn from the prompt to its final reply', () => {
    const entries = [
      msg('u', 0, { role: 'user', content: 'go' }),
      msg('a1', 5, {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }],
      }),
      msg('r1', 20, { role: 'toolResult', toolCallId: 't1', content: [] }),
      msg('a2', 72, {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'done' }],
      }),
    ].map((item) => ({ ...item, reply: null }));
    const [, activity] = groupConversationActivity(entries, new Map());
    expect(activity.toolCount).toBe(1);
    expect(activity.durationMs).toBe(72000);
    const [, finishedWhileStatusUpdates] = groupConversationActivity(entries, new Map(), true);
    expect(finishedWhileStatusUpdates.running).toBeFalsy();
  });

  it('treats a message steered into a running turn as a continuation', () => {
    const tool = (id, s) =>
      msg(id, s, {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't' + id, name: 'bash', arguments: {} }],
      });
    const result = (id, s) =>
      msg(id, s, { role: 'toolResult', toolCallId: 't' + id[1], content: [] });
    const activity = (entries) =>
      groupConversationActivity(entries, new Map(), true).filter((section) => section.items)[0];
    const start = [msg('u', 0, { role: 'user', content: 'go' }), tool('a', 1), result('ra', 2)];

    const steered = activity([
      ...start,
      msg('s', 4, { role: 'user', content: 'also' }),
      tool('b', 6),
    ]);
    expect(steered).toMatchObject({ steered: true });
    expect(steered.unfinished).toBeFalsy();
    const compacted = activity([
      ...start,
      { entry: { id: 'c', type: 'compaction', timestamp: at(50) } },
      msg('s', 51, { role: 'user', content: 'also' }),
    ]);
    expect(compacted).toMatchObject({ steered: true });
    const later = activity([...start, msg('s', 300, { role: 'user', content: 'again' })]);
    expect(later).toMatchObject({ unfinished: true });
  });

  it('marks a turn that ended without a reply as unfinished', () => {
    const tool = (id, s) =>
      msg(id, s, {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't' + id, name: 'bash', arguments: {} }],
      });
    const cut = msg('cut', 9, {
      role: 'assistant',
      stopReason: 'length',
      content: [{ type: 'thinking', thinking: 'long' }],
    });
    const turn = [msg('u', 0, { role: 'user', content: 'go' }), tool('a', 1)];
    const groups = (entries, running) =>
      groupConversationActivity(entries, new Map(), running).filter((section) => section.items);

    expect(groups(turn, true)[0]).toMatchObject({ running: true });
    expect(groups(turn, true)[0].unfinished).toBeFalsy();
    expect(groups(turn, null)[0].unfinished).toBeFalsy();
    expect(groups(turn, false)[0].unfinished).toBe(true);
    const [, activity, truncated] = groupConversationActivity([...turn, cut], new Map());
    expect(activity.toolCount).toBe(1);
    expect(truncated.item).toMatchObject({ entry: cut.entry, skipActivity: true });
  });

  it('keeps one turn when the server continued after an empty reply', () => {
    const tool = (id, s) =>
      msg(id, s, {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't' + id, name: 'bash', arguments: {} }],
      });
    const empty = msg('e', 3, {
      role: 'assistant',
      stopReason: 'stop',
      content: [],
      usage: { output: 0 },
    });
    const resume = msg('c', 4, { role: 'user', content: 'Continue.' });
    const done = msg('d', 9, { role: 'assistant', stopReason: 'stop', content: 'done' });
    const sections = groupConversationActivity(
      entriesWithReplyDetails(
        [
          msg('u', 0, { role: 'user', content: 'go' }),
          tool('a', 1),
          empty,
          resume,
          tool('b', 5),
          done,
        ].map((item) => item.entry),
      ),
      new Map(),
    );
    const groups = sections.filter((section) => section.items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ toolCount: 2, autoContinued: true });
    expect(groups[0].unfinished).toBeFalsy();
    expect(sections.filter((section) => section.item?.autoContinued)).toHaveLength(2);
    expect(sections.at(-1).item.reply.text).toBe('done');

    // Without the recovery prompt the empty reply still ends the turn.
    const ended = entriesWithReplyDetails(
      [msg('u', 0, { role: 'user', content: 'go' }), empty].map((item) => item.entry),
    );
    expect(ended[1]).toMatchObject({ emptyReply: true });
  });
});

describe('entry formatting', () => {
  it('formats elapsed time compactly', () => {
    expect(formatElapsed(800)).toBe('1s');
    expect(formatElapsed(72000)).toBe('1m 12s');
    expect(formatElapsed(3_780_000)).toBe('1h 3m');
  });

  it('hides image resize notes meant for the model', () => {
    const text =
      'look at this\n[Image: original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]';
    expect(stripImageNotes(text)).toBe('look at this');
    expect(stripImageNotes('[Image: something else]')).toBe('[Image: something else]');
  });

  it('shows only the clock for today and adds the date otherwise', () => {
    const now = new Date(2026, 10, 19, 12, 0);
    expect(formatShortTime(new Date(2026, 10, 19, 10, 38), now)).not.toMatch(/11\/19|19/);
    expect(formatShortTime(new Date(2026, 10, 18, 10, 38), now)).toMatch(/18/);
    expect(formatShortTime('', now)).toBe('');
  });
});

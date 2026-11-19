import { describe, expect, it } from 'vitest';
import { groupConversationActivity } from './conversation-activity.js';
import { formatElapsed, formatShortTime, stripImageNotes } from './entry-format.js';

const at = (s) => new Date(Date.UTC(2026, 10, 19, 2, 0, s)).toISOString();
const msg = (id, s, message) => ({ entry: { id, type: 'message', timestamp: at(s), message } });

describe('conversation activity duration', () => {
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
    expect(groups(turn, false)[0].unfinished).toBe(true);
    const [, activity, truncated] = groupConversationActivity([...turn, cut], new Map());
    expect(activity.toolCount).toBe(1);
    expect(truncated.item).toMatchObject({ entry: cut.entry, skipActivity: true });
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

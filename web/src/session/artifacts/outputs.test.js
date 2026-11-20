import { describe, expect, it } from 'vitest';
import { groupOutputsByReply } from './outputs.js';

const user = (id) => ({ entry: { id, type: 'message', message: { role: 'user' } } });
const assistant = (id, reply = true) => ({
  entry: { id, type: 'message', message: { role: 'assistant', content: [] } },
  reply,
});
const toolResult = (id) => ({ entry: { id, type: 'message', message: { role: 'toolResult' } } });

describe('groupOutputsByReply', () => {
  it('anchors an output to the reply that produced it', () => {
    const entries = [user('u1'), assistant('a1'), toolResult('t1')];
    const { byEntry, unassigned } = groupOutputsByReply(entries, [
      { id: 'o1', entryId: 'a1' },
      { id: 'o2', entryId: 't1' },
    ]);

    expect(unassigned).toEqual([]);
    expect(byEntry.get('a1').map((o) => o.id)).toEqual(['o1', 'o2']);
  });

  it('keeps outputs of different turns with their own reply', () => {
    const entries = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), toolResult('t2')];
    const { byEntry } = groupOutputsByReply(entries, [{ id: 'late', entryId: 't2' }]);

    expect(byEntry.get('a2').map((o) => o.id)).toEqual(['late']);
    expect(byEntry.has('a1')).toBe(false);
  });

  it('anchors a file discovered without an entryId to the newest reply', () => {
    const entries = [user('u1'), assistant('a1'), assistant('a2')];
    const { byEntry, unassigned } = groupOutputsByReply(entries, [{ id: 'asset' }]);

    expect(unassigned).toEqual([]);
    expect(byEntry.get('a2').map((o) => o.id)).toEqual(['asset']);
  });

  it('leaves outputs unassigned when the session has no reply yet', () => {
    const { byEntry, unassigned } = groupOutputsByReply([user('u1')], [{ id: 'asset' }]);

    expect(byEntry.size).toBe(0);
    expect(unassigned.map((o) => o.id)).toEqual(['asset']);
  });
});

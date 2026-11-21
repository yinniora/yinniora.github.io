import { describe, expect, it } from 'vitest';
import setupTaskCheckpoint from '../../internal/rpc/task_checkpoint.mjs';

type Entry = {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  firstKeptEntryId?: string;
  timestamp?: string;
  text?: string;
  message?: { role: string; [key: string]: unknown };
};

function install(branch: Entry[] = []) {
  let current = branch;
  let tool: { execute: (...args: any[]) => Promise<any> };
  const hooks = new Map<string, (...args: any[]) => unknown>();
  const ctx = { sessionManager: { getBranch: () => current } };
  setupTaskCheckpoint({
    registerTool: (definition: typeof tool) => {
      tool = definition;
    },
    appendEntry: (customType: string, data: unknown) => {
      current.push({ id: `checkpoint-${current.length}`, type: 'custom', customType, data });
    },
    on: (name: string, callback: (...args: any[]) => unknown) => hooks.set(name, callback),
  });
  return {
    setBranch: (entries: Entry[]) => {
      current = entries;
    },
    run: async (input = {}, signal?: AbortSignal) =>
      (await tool.execute('tool-1', input, signal, undefined, ctx)).content[0].text as string,
    project: (messages: unknown[]) => hooks.get('context_with_system')!({ messages }, ctx),
    begin: (messageType = 'user') => hooks.get('before_agent_start')!({ messageType }, ctx),
    guide: () => hooks.get('message_start')!({ message: { role: 'user' } }, ctx),
    settle: () => hooks.get('agent_settled')!({}, ctx),
    boundary: ({
      outcome = 'completed',
      stopReason = 'stop',
      pending = false,
      entries = [] as unknown[],
      text = 'Finished this step.',
    } = {}) =>
      hooks.get('agent_before_settle')!(
        {
          outcome,
          entries,
          context: {
            pendingMessages: pending ? [{ role: 'user' }] : [],
            contextMessages: [{ role: 'assistant', stopReason, content: [{ type: 'text', text }] }],
          },
        },
        ctx,
      ),
  };
}

describe('YuGo task checkpoint', () => {
  it('merges multiple pieces of guidance and restores open tasks after restart', async () => {
    const branch: Entry[] = [];
    const first = install(branch);
    await first.run({
      goal: 'Stabilize long conversations',
      tasks: [{ id: 'retry', text: 'Fix one-shot timeouts', state: 'working' }],
    });
    branch.push({ id: 'steer-1', type: 'message', text: 'Preserve streaming previews' });
    await first.run({ addConstraints: ['Preserve streaming previews'] });
    branch.push({ id: 'steer-2', type: 'message', text: 'Also validate the release' });
    await first.run({ tasks: [{ id: 'verify', text: 'Run the browser regressions' }] });
    branch.push({ id: 'steer-3', type: 'message', text: 'Use the existing retry state' });
    await first.run({
      tasks: [{ id: 'retry', state: 'blocked', note: 'Awaiting a repeatable fixture' }],
    });

    const restarted = install(structuredClone(branch));
    const restored = await restarted.run();
    expect(restored).toContain('Goal: Stabilize long conversations');
    expect(restored).toContain('Keep: Preserve streaming previews');
    expect(restored).toContain('verify [todo] Run the browser regressions');
    expect(restored).toContain(
      'retry [blocked] Fix one-shot timeouts (Awaiting a repeatable fixture)',
    );
  });

  it('keeps tasks open unless explicitly settled with evidence', async () => {
    const branch: Entry[] = [];
    const checkpoint = install(branch);
    await checkpoint.run({ tasks: [{ id: 'test', text: 'Run the regression suite' }] });
    await expect(checkpoint.run({ tasks: [{ id: 'test', state: 'done' }] })).rejects.toThrow(
      'evidence',
    );
    expect(branch).toHaveLength(1);
    expect(await checkpoint.run()).toContain('test [todo]');
    await expect(checkpoint.run({ tasks: [{ id: 'test', state: 'dropped' }] })).rejects.toThrow(
      'reason',
    );
    expect(
      await checkpoint.run({ tasks: [{ id: 'test', state: 'done', note: 'Both suites passed' }] }),
    ).toContain('No open tasks');
    expect(await checkpoint.run()).toContain(
      'test [done] Run the regression suite (Both suites passed)',
    );
    await checkpoint.run({ tasks: [{ id: 'test', state: 'working' }] });
    expect(await checkpoint.run()).toBe('test [working] Run the regression suite');
  });

  it('reads only a branch’s own entries and inherits a shared ancestor when explicitly forked', async () => {
    const ancestor: Entry[] = [];
    const checkpoint = install(ancestor);
    await checkpoint.run({
      goal: 'Shared goal',
      tasks: [{ id: 'docs', text: 'Update documentation' }],
    });
    const oldBranch = [...ancestor];
    checkpoint.setBranch(oldBranch);
    await checkpoint.run({ tasks: [{ id: 'private', text: 'Old branch only' }] });

    checkpoint.setBranch([...ancestor]);
    const fork = await checkpoint.run();
    expect(fork).toContain('docs [todo]');
    expect(fork).not.toContain('Old branch only');
    checkpoint.setBranch([{ id: 'new-root', type: 'message' }]);
    expect(await checkpoint.run()).toBe('No task checkpoint has been saved.');
  });

  it('restores a stable baseline at compaction while leaving the stored summary intact', async () => {
    const branch: Entry[] = [];
    const checkpoint = install(branch);
    await checkpoint.run({
      goal: 'Earlier goal',
      tasks: [{ id: 'tests', text: 'Still verify scenarios' }],
    });
    const timestamp = '2026-11-21T00:00:00.000Z';
    branch.push(
      { id: 'kept', type: 'message' },
      { id: 'compact', type: 'compaction', firstKeptEntryId: 'kept', timestamp },
    );
    const head = { role: 'system', content: 'Prompt and tool declarations' };
    const original = {
      role: 'compactionSummary',
      timestamp: Date.parse(timestamp),
      summary: 'Lossy summary',
    };
    const messages = [head, original];
    const projected = checkpoint.project(messages) as { messages: typeof messages };
    expect(projected.messages[0]).toBe(head);
    expect(projected.messages[1]).toMatchObject({
      summary: expect.stringContaining('tests [todo] Still verify scenarios'),
    });
    expect(original.summary).toBe('Lossy summary');
    await checkpoint.run({
      tasks: [{ id: 'tests', state: 'done', note: 'Three fixtures passed' }],
    });
    expect(checkpoint.project(messages)).toEqual(projected);
    expect(install(structuredClone(branch)).project(messages)).toEqual(projected);

    const later = '2026-11-21T00:01:00.000Z';
    branch.push({
      id: 'compact-again',
      type: 'compaction',
      firstKeptEntryId: 'kept',
      timestamp: later,
    });
    const recompacted = { ...original, timestamp: Date.parse(later) };
    const corrected = checkpoint.project([head, recompacted]) as { messages: typeof messages };
    expect(corrected.messages[1]).toMatchObject({
      summary: expect.stringContaining(
        'tests [done] Still verify scenarios (Three fixtures passed)',
      ),
    });
    expect(corrected.messages[1]).not.toMatchObject({
      summary: expect.stringContaining('tests [todo]'),
    });
    expect(checkpoint.project(corrected.messages)).toBeUndefined();
  });

  it('keeps the summary untouched when all checkpoint updates are still within the retained range', async () => {
    const branch: Entry[] = [{ id: 'kept', type: 'message' }];
    const checkpoint = install(branch);
    await checkpoint.run({ goal: 'A recent goal' });
    const timestamp = '2026-11-21T00:02:00.000Z';
    branch.push({ id: 'compact', type: 'compaction', firstKeptEntryId: 'kept', timestamp });
    expect(
      checkpoint.project([
        { role: 'compactionSummary', timestamp: Date.parse(timestamp), summary: 'Native summary' },
      ]),
    ).toBeUndefined();
  });

  it('adds no checkpoint text and writes no records for a turn without a saved checkpoint', async () => {
    const branch: Entry[] = [{ id: 'u', type: 'message' }];
    const checkpoint = install(branch);
    expect(checkpoint.project([{ role: 'user', content: 'A short question' }])).toBeUndefined();
    expect(await checkpoint.run()).toBe('No task checkpoint has been saved.');
    expect(branch).toHaveLength(1);
    const stopped = new AbortController();
    stopped.abort();
    await expect(checkpoint.run({ goal: 'Do not persist' }, stopped.signal)).rejects.toThrow();
    expect(branch).toHaveLength(1);
  });

  it('continues current open work once and preserves other extension drafts', async () => {
    const branch: Entry[] = [{ id: 'u', type: 'message', message: { role: 'user' } }];
    const checkpoint = install(branch);
    checkpoint.begin();
    await checkpoint.run({
      goal: 'Release the fix',
      tasks: [{ id: 'test', text: 'Verify the release', state: 'working' }],
    });
    expect(checkpoint.boundary({ pending: true })).toBeUndefined();
    const draft = { type: 'custom', customType: 'other-extension' };
    expect(checkpoint.boundary({ entries: [draft] })).toEqual({
      continue: true,
      entries: [
        draft,
        {
          type: 'custom_message',
          customType: 'yugo-task-continuation',
          display: false,
          content: expect.stringContaining('test: Verify the release'),
        },
      ],
    });
    await checkpoint.run({ tasks: [{ id: 'test', note: 'Checks still running' }] });
    expect(checkpoint.boundary()).toBeUndefined();
    checkpoint.settle();
    checkpoint.begin();
    await checkpoint.run({ tasks: [{ id: 'test', note: 'Checks still running' }] });
    expect(checkpoint.boundary()).toBeUndefined();
  });

  it('settles completed, blocked, errored, cancelled and user-dependent work', async () => {
    const branch: Entry[] = [{ id: 'u', type: 'message', message: { role: 'user' } }];
    const checkpoint = install(branch);
    checkpoint.begin();
    await checkpoint.run({ goal: 'Deliver fix', tasks: [{ id: 'test', text: 'Verify' }] });
    expect(checkpoint.boundary({ outcome: 'error', stopReason: 'error' })).toBeUndefined();
    expect(checkpoint.boundary({ outcome: 'aborted' })).toBeUndefined();
    expect(checkpoint.boundary({ stopReason: 'length' })).toBeUndefined();
    expect(checkpoint.boundary({ text: ' ' })).toBeUndefined();
    branch.push({
      id: 'ask',
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'pi_web_ask_user_question',
        details: { awaitingChatReply: true },
      },
    });
    expect(checkpoint.boundary()).toBeUndefined();
    branch.pop();
    branch.push({
      id: 'denied',
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'act_ui',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This computer action was declined. Do not retry or use another tool for the blocked action. Continue unrelated work.',
          },
        ],
      },
    });
    expect(checkpoint.boundary()).toBeUndefined();
    branch.pop();
    await expect(checkpoint.run({ tasks: [{ id: 'test', state: 'blocked' }] })).rejects.toThrow(
      'blocks',
    );
    await checkpoint.run({
      tasks: [{ id: 'test', state: 'blocked', note: 'Awaiting target access' }],
    });
    expect(checkpoint.boundary()).toBeUndefined();
    await checkpoint.run({ tasks: [{ id: 'test', state: 'done', note: 'All checks passed' }] });
    expect(checkpoint.boundary()).toBeUndefined();
  });

  it('lets guidance supersede a checkpoint until the guided work is recorded', async () => {
    const checkpoint = install([{ id: 'u', type: 'message', message: { role: 'user' } }]);
    checkpoint.begin();
    await checkpoint.run({ goal: 'Ship changes', tasks: [{ id: 'ship', text: 'Publish' }] });
    checkpoint.guide();
    expect(checkpoint.boundary()).toBeUndefined();
    await checkpoint.run({ tasks: [{ id: 'ship', text: 'Verify the build without publishing' }] });
    expect(checkpoint.boundary()).toMatchObject({ continue: true });
  });

  it('restores the acceptance check and closed states with older evidence available on demand', async () => {
    const branch: Entry[] = [{ id: 'u', type: 'message', message: { role: 'user' } }];
    const checkpoint = install(branch);
    checkpoint.begin();
    await checkpoint.run({
      goal: 'Restore streaming',
      verification: 'Reconnect and receive the model reply without losing partial output',
      tasks: [
        {
          id: 'path',
          text: 'Check network path',
          state: 'done',
          note: 'Probed server on localhost',
        },
        { id: 'fix', text: 'Implement reconnect', state: 'done', note: 'Committed abc123' },
        { id: 'test', text: 'Verify full response' },
      ],
    });
    const timestamp = '2026-11-21T00:04:00.000Z';
    branch.push(
      { id: 'kept', type: 'message' },
      { id: 'compact', type: 'compaction', firstKeptEntryId: 'kept', timestamp },
    );
    const saved = [
      { role: 'compactionSummary', timestamp: Date.parse(timestamp), summary: 'Summary' },
    ];
    const projected = checkpoint.project(saved) as { messages: typeof saved };
    expect(projected.messages[0].summary).toContain('Verify: Reconnect and receive');
    expect(projected.messages[0].summary).toContain('test [todo] Verify full response');
    expect(projected.messages[0].summary).toContain('Committed abc123');
    expect(projected.messages[0].summary).toContain('Closed: path [done]');
    expect(projected.messages[0].summary).not.toContain('Probed server on localhost');
    expect(await checkpoint.run()).toContain('Probed server on localhost');
    expect(checkpoint.boundary()).toMatchObject({
      entries: [{ content: expect.stringContaining('Verify: Reconnect and receive') }],
    });
    await checkpoint.run({ goal: 'An unrelated goal' });
    expect(await checkpoint.run()).not.toContain('Verify:');
  });
});

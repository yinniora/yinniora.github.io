import { Type } from 'typebox';

const entryType = 'yugo-task-checkpoint';
const continuationType = 'yugo-task-continuation';
const maxOpen = 12;
const maxClosed = 5;
const maxConstraints = 6;
const maxBytes = 5 * 1024;
const openStates = ['todo', 'working', 'blocked'];
const closedStates = ['done', 'dropped'];

const constraintSchema = Type.String({ maxLength: 120 });
const parameters = Type.Object({
  goal: Type.Optional(Type.String({ maxLength: 240 })),
  addConstraints: Type.Optional(Type.Array(constraintSchema, { maxItems: maxConstraints })),
  removeConstraints: Type.Optional(Type.Array(constraintSchema, { maxItems: maxConstraints })),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,23}$' }),
        text: Type.Optional(Type.String({ maxLength: 140 })),
        state: Type.Optional(Type.Enum([...openStates, ...closedStates], { type: 'string' })),
        note: Type.Optional(Type.String({ maxLength: 120 })),
      }),
      { maxItems: maxOpen },
    ),
  ),
});

function latestCheckpoint(branch) {
  const entry = branch.findLast(
    (entry) => entry.type === 'custom' && entry.customType === entryType,
  );
  return entry?.data?.version === 1 ? entry.data : null;
}

function oneLine(text) {
  return text?.trim().replace(/\s+/g, ' ') || '';
}

function formatCheckpoint(state) {
  if (!state) return 'No task checkpoint has been saved.';
  return [
    state.goal && `Goal: ${state.goal}`,
    ...state.constraints.map((constraint) => `Keep: ${constraint}`),
    ...state.tasks.map(
      ({ id, text, state, note }) => `${id} [${state}] ${text}${note ? ` (${note})` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

function updateCheckpoint(previous, input) {
  const goal = oneLine(input.goal) || previous?.goal || '';
  const removed = new Set((input.removeConstraints || []).map(oneLine));
  const constraints = [
    ...new Set([
      ...(previous?.constraints || []).filter((constraint) => !removed.has(constraint)),
      ...(input.addConstraints || []).map(oneLine).filter(Boolean),
    ]),
  ];
  if (constraints.length > maxConstraints) {
    throw new Error(`Keep up to ${maxConstraints} essential constraints.`);
  }

  const tasks = new Map((previous?.tasks || []).map((task) => [task.id, task]));
  for (const change of input.tasks || []) {
    const current = tasks.get(change.id);
    const text = oneLine(change.text) || current?.text;
    const state = change.state || current?.state || 'todo';
    const note =
      oneLine(change.note) ||
      (state === current?.state && text === current.text ? current.note : undefined);
    if (!text) throw new Error(`Add a short description for task ${change.id}.`);
    if (closedStates.includes(state) && !note) {
      throw new Error(`Record evidence for completion or the reason for dropping ${change.id}.`);
    }
    if (state === 'blocked' && !note) {
      throw new Error(`Record what blocks ${change.id}.`);
    }
    const updated = { id: change.id, text, state, ...(note && { note }) };
    if (JSON.stringify(updated) !== JSON.stringify(current)) {
      tasks.delete(change.id);
      tasks.set(change.id, updated);
    }
  }
  const open = [];
  const closed = [];
  for (const task of tasks.values()) (closedStates.includes(task.state) ? closed : open).push(task);
  if (open.length > maxOpen) throw new Error(`Keep up to ${maxOpen} open work items.`);

  const updated = { version: 1, goal, constraints, tasks: [...open, ...closed.slice(-maxClosed)] };
  if (!goal && !constraints.length && !tasks.size)
    throw new Error('Add a goal, constraint or task.');
  if (Buffer.byteLength(formatCheckpoint(updated)) > maxBytes) {
    throw new Error(
      'Shorten the checkpoint while keeping the open tasks and essential constraints.',
    );
  }
  return updated;
}

function restoreAfterCompaction(messages, sessionManager) {
  const index = messages.findLastIndex((message) => message.role === 'compactionSummary');
  if (index < 0) return;
  const summary = messages[index];
  const branch = sessionManager.getBranch();
  const compactedAt = branch.findLastIndex((entry) => entry.type === 'compaction');
  const compaction = branch[compactedAt];
  if (!compaction || summary.timestamp !== Date.parse(compaction.timestamp)) return;
  const firstKept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKept < 1 || !latestCheckpoint(branch.slice(0, firstKept))) return;

  // Use the last state at compaction, even when a repeated compaction keeps the same boundary.
  // Later updates remain in the transcript and do not rewrite the model's cached prefix.
  const text = formatCheckpoint(latestCheckpoint(branch.slice(0, compactedAt)));
  const checkpoint = `Task checkpoint at compaction. It includes all earlier checkpoint updates. Treat retained earlier messages as reference. Apply later changes and user instructions.\n${text}`;
  if (summary.summary.includes(checkpoint)) return;

  const projected = messages.slice();
  projected[index] = {
    ...summary,
    summary: `${summary.summary}\n\n${checkpoint}`,
  };
  return projected;
}

export default function setupTaskCheckpoint(pi) {
  let userRun = false;
  let checkpointChanged = false;
  let continued = false;

  pi.on('before_agent_start', (event) => {
    userRun = event.messageType === 'user';
    checkpointChanged = false;
    continued = false;
  });

  pi.on('message_start', ({ message }) => {
    if (message.role === 'user') checkpointChanged = false;
  });

  pi.on('agent_settled', () => {
    userRun = false;
  });

  pi.registerTool({
    name: 'yugo_task_checkpoint',
    label: 'Task checkpoint',
    description:
      'Read or patch this branch’s checkpoint. Tasks merge by ID. Other work and constraints are retained. Closing a task requires a note.',
    promptGuidelines: [
      'Batch checkpoint updates with useful tools for multi-step work. Keep the goal and open items under new guidance. Verify before closing. Record blockers. Omit secrets and logs.',
    ],
    parameters,
    async execute(_id, input, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const previous = latestCheckpoint(ctx.sessionManager.getBranch());
      let text;
      if (
        !input.goal &&
        !input.addConstraints?.length &&
        !input.removeConstraints?.length &&
        !input.tasks?.length
      ) {
        text = formatCheckpoint(previous);
      } else {
        const updated = updateCheckpoint(previous, input);
        if (JSON.stringify(updated) !== JSON.stringify(previous)) {
          pi.appendEntry(entryType, updated);
          checkpointChanged = true;
        }
        const open = updated.tasks.filter((task) => openStates.includes(task.state));
        text = open.length
          ? `Saved. Open: ${open.map((task) => task.id).join(', ')}.`
          : 'Saved. No open tasks.';
      }
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  pi.on('context_with_system', (event, ctx) => {
    const messages = restoreAfterCompaction(event.messages, ctx.sessionManager);
    if (messages) return { messages };
  });

  pi.on('agent_before_settle', (event, ctx) => {
    if (
      !userRun ||
      !checkpointChanged ||
      continued ||
      event.outcome !== 'completed' ||
      event.continue ||
      event.context.pendingMessages.length
    ) {
      return;
    }

    const final = event.context.contextMessages.at(-1);
    if (final?.role !== 'assistant' || final.stopReason !== 'stop') return;
    if (!final.content?.some(({ type, text }) => type === 'text' && text?.trim())) return;

    const branch = ctx.sessionManager.getBranch();
    const checkpoint = latestCheckpoint(branch);
    const actionable = checkpoint?.tasks.filter(
      ({ state }) => state === 'todo' || state === 'working',
    );
    if (!checkpoint?.goal || !actionable?.length) return;

    const userIndex = branch.findLastIndex(
      ({ type, message }) => type === 'message' && message?.role === 'user',
    );
    const blockedByUser = branch.slice(userIndex + 1).some(({ type, message }) => {
      if (type !== 'message' || message?.role !== 'toolResult') return false;
      const { toolName, details, isError, content } = message;
      if (toolName === 'pi_web_ask_user_question' || toolName === 'ask_user_question') {
        return (
          isError ||
          details?.awaitingChatReply ||
          details?.timedOut ||
          details?.cancelled ||
          details?.skipped
        );
      }
      return (
        isError &&
        content?.some(
          ({ type, text }) =>
            type === 'text' &&
            text.includes('Do not retry or use another tool for the blocked action.'),
        )
      );
    });
    if (blockedByUser) return;

    continued = true;
    const tasks = actionable.map(({ id, text }) => `${id}: ${text}`).join('\n');
    return {
      continue: true,
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: continuationType,
          display: false,
          content: `Open work:\n${tasks}\nTake the next authorized step, verify before closing, or report the blocker.`,
        },
      ],
    };
  });
}

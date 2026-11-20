import { entryTime } from './entry-format.js';

const questionTools = new Set(['ask_user_question', 'pi_web_ask_user_question', 'ask_question']);

export function isQuestionTool(name) {
  return questionTools.has(name);
}

export function questionNeedsResponse(name, result) {
  return (
    isQuestionTool(name) &&
    (!result ||
      result.details?.awaitingChatReply ||
      (name !== 'pi_web_ask_user_question' && (result.isError || result.details?.cancelled)))
  );
}

const toolKinds = [
  ['command', /^(bash|shell|exec|run_command|terminal)$/],
  ['read', /^(read|read_file|view|cat)$/],
  ['edit', /^(edit|write|multi_edit|apply_patch|str_replace|create_file)$/],
  ['search', /^(grep|find|ls|glob|search|list_files|rg)$/],
  ['web', /^(web_search|web_fetch|fetch|search_web|browse)$/],
  [
    'ui',
    /^(find_roots|observe_ui|search_ui|expand_ui|inspect_ui|act_ui|read_text|wait_for|launch_browser|navigate_browser|evaluate_browser|computer)$/,
  ],
];

export function toolKind(name) {
  const plain = String(name || '')
    .toLowerCase()
    .replace(/^.*__/, '');
  for (const [kind, pattern] of toolKinds) if (pattern.test(plain)) return kind;
  return 'other';
}

// The activity in reading order: text and thinking as written, consecutive
// tool calls merged into one run (one summary line), and questions on their
// own so they stay visible.
function appendTimeline(timeline, item, results) {
  const id = item.entry.id;
  const start = timeline.length;
  const blocks =
    item.blocks || (Array.isArray(item.entry.message?.content) ? item.entry.message.content : []);
  blocks.forEach((block, index) => {
    const key = `${id}:${index}`;
    if (block.type === 'text' && block.text?.trim() && !item.blocks) {
      timeline.push({ kind: 'text', key, text: block.text });
    } else if (block.type === 'thinking' && block.thinking?.trim()) {
      const timestamp = item.entry.message?.timestamp;
      timeline.push({
        kind: 'thinking',
        key: timestamp ? `thought:${timestamp}:${item.thinkingIndex ?? index}` : key,
        text: block.thinking,
        streaming: item.streaming,
      });
    } else if (block.type === 'toolCall' && isQuestionTool(block.name)) {
      timeline.push({ kind: 'question', key, call: block });
    } else if (block.type === 'toolCall') {
      let run = timeline.at(-1);
      if (run?.kind !== 'tools') {
        run = {
          kind: 'tools',
          key: 'tools:' + key,
          calls: [],
          counts: {},
          failures: 0,
          pending: null,
        };
        timeline.push(run);
      }
      const result = results.get(block.id);
      const kind = toolKind(block.name);
      run.calls.push(block);
      if (!result) run.pending = block;
      else {
        run.counts[kind] = (run.counts[kind] || 0) + 1;
        if (result.isError) run.failures++;
      }
      if (kind === 'other') (run.others ||= new Set()).add(block.name);
    }
  });
  // Keep the entry's anchor (tree navigation, links to entries) on its first
  // step; a tool run merged from earlier entries carries extra anchors.
  const step = timeline[start] || timeline.at(-1);
  if (step && !item.streaming && !item.retried) (step.anchors ||= []).push(id);
}

const STEER_GAP_MS = 15000;

function isSteer(before, entry) {
  const kind = before?.type === 'message' ? before.message?.role : before?.type;
  if (kind !== 'toolResult' && kind !== 'compaction') return false;
  if (isQuestionTool(before?.message?.toolName)) return false;
  const gap = entryTime(entry) - entryTime(before);
  return Number.isFinite(gap) && gap >= 0 && gap <= STEER_GAP_MS;
}

export function groupConversationActivity(
  entries,
  outputsByEntry,
  running = false,
  thinkingPreviews = [],
) {
  const results = new Map();
  for (const { entry } of entries) {
    const message = entry.type === 'message' && entry.message;
    if (message?.role === 'toolResult') results.set(message.toolCallId, message);
  }

  const sections = [];
  let activity = null;
  let latestActivity = null;
  let turnStartedAt = 0;
  function addActivity(item, thoughts, tools) {
    if (!activity) {
      activity = {
        key: 'activity:' + (item.entry.message?.timestamp || item.entry.id),
        items: [],
        thinking: 0,
        toolCount: 0,
        failures: 0,
        retries: 0,
        latestTool: '',
        outputs: [],
        timeline: [],
        needsResponse: false,
        questionOutcome: '',
        startedAt: turnStartedAt || entryTime(item.entry),
        endedAt: 0,
      };
      sections.push(activity);
      latestActivity = activity;
    }
    activity.items.push(item);
    appendTimeline(activity.timeline, item, results);
    activity.endedAt = Math.max(activity.endedAt, entryTime(item.entry));
    activity.thinking += thoughts;
    activity.toolCount += tools.length;
    for (const tool of tools) {
      activity.latestTool = tool.name;
      if (results.get(tool.id)?.isError) activity.failures++;
    }
  }

  // The entry before the current one, to tell a steer from a stopped turn.
  let previous = null;
  for (let item of entries) {
    const { entry } = item;
    const message = entry.type === 'message' && entry.message;
    const before = previous;
    if (entry.type !== 'session_info') previous = entry;
    // The server continued a turn the provider closed with an empty reply:
    // keep one activity group and note the recovery in its summary.
    if (item.autoContinued) {
      if (activity) activity.autoContinued = true;
      sections.push({ key: entry.id, item });
      continue;
    }
    if (item.retried) {
      const blocks = Array.isArray(message?.content)
        ? message.content.map((block) => (block.type === 'thinking' ? block : {}))
        : [];
      addActivity(
        { ...item, blocks },
        blocks.filter((block) => block.type === 'thinking').length,
        [],
      );
      activity.retries++;
    }
    if (item.retried || item.repeatedError) {
      sections.push({ key: entry.id, item: { ...item, retried: true } });
      continue;
    }
    if (
      message?.role === 'toolResult' ||
      entry.type === 'thinking_level_change' ||
      entry.type === 'session_info' ||
      (entry.type === 'model_change' && entry.implicit)
    )
      continue;
    if (message?.role === 'user') {
      // The previous turn never reached a reply: it was cut off, stopped or
      // lost its runner. Say so instead of looking finished.
      // A message steered into a running turn lands right after a tool result
      // (or Pi's between-turn compaction): the turn went on, it did not stop.
      if (activity) {
        if (isSteer(before, entry)) activity.steered = true;
        else if (!activity.needsResponse) activity.unfinished = true;
      }
      activity = null;
      latestActivity = null;
      turnStartedAt = entryTime(entry);
    }
    if (message?.role === 'assistant' && !item.repeatedError) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const tools = blocks.filter((block) => block.type === 'toolCall');
      const thoughtCount = blocks.filter(
        (block) => block.type === 'thinking' && block.thinking?.trim(),
      ).length;
      const final =
        item.reply ||
        item.emptyReply ||
        ['aborted', 'error', 'length'].includes(message.stopReason);
      if (!final && (tools.length || thoughtCount || message.stopReason === 'toolUse')) {
        addActivity(item, thoughtCount, tools);
        activity.outputs.push(...(outputsByEntry?.get(entry.id) || []));
        for (const tool of tools) {
          if (!isQuestionTool(tool.name)) continue;
          const result = results.get(tool.id);
          if (result || running || tool.name !== 'pi_web_ask_user_question') {
            activity.needsResponse ||= questionNeedsResponse(tool.name, result);
          }
          if (result?.details?.timedOut) activity.questionOutcome = 'timeout';
          else if (result?.details?.cancelled) activity.questionOutcome = 'stopped';
        }
        continue;
      }
      if (tools.length || thoughtCount) {
        addActivity({ entry, blocks }, thoughtCount, tools);
        item = { ...item, skipActivity: true };
      }
      // The turn ends with this reply; count its time in the activity duration.
      if (activity) activity.endedAt = Math.max(activity.endedAt, entryTime(entry));
      activity = null;
    }
    sections.push({ key: entry.id, item });
  }

  if (thinkingPreviews.length) {
    const persisted = new Set(
      entries
        .filter(({ entry }) => entry.message?.role === 'assistant')
        .map(({ entry }) => entry.message.timestamp),
    );
    for (const { messageTimestamp, thinkingIndex, thinking } of thinkingPreviews) {
      if (persisted.has(messageTimestamp)) continue;
      addActivity(
        {
          entry: {
            id: 'preview:' + messageTimestamp,
            message: { timestamp: messageTimestamp, content: [{ type: 'thinking', thinking }] },
          },
          thinkingIndex,
          streaming: true,
        },
        1,
        [],
      );
    }
  }
  for (const section of sections) {
    if (section.items) section.durationMs = Math.max(0, section.endedAt - section.startedAt);
  }
  if (latestActivity && running) latestActivity.running = true;
  if (activity) {
    activity.running = running;
    // Not running and still no reply: the turn ended without finishing.
    if (!running && !activity.needsResponse) activity.unfinished = true;
  }
  // A question the user has not answered yet keeps its group open even after
  // the turn's closing reply, until the next user message. Otherwise a reload
  // (or returning to the page) folds the question away.
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index];
    if (!section.items && section.item.entry.message?.role === 'user') break;
    if (section.items) section.required = section.needsResponse;
  }
  return sections;
}

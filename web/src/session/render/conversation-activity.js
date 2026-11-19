import { entryTime } from './entry-format.js';

const questionTools = new Set(['ask_user_question', 'pi_web_ask_user_question', 'ask_question']);

export function isQuestionTool(name) {
  return questionTools.has(name);
}

export function questionNeedsResponse(name, result) {
  return (
    isQuestionTool(name) &&
    (!result || result.isError || result.details?.awaitingChatReply || result.details?.cancelled)
  );
}

export function groupConversationActivity(entries, outputsByEntry, running = false) {
  const results = new Map();
  for (const { entry } of entries) {
    const message = entry.type === 'message' && entry.message;
    if (message?.role === 'toolResult') results.set(message.toolCallId, message);
  }

  const sections = [];
  let activity = null;
  let turnStartedAt = 0;
  function addActivity(item, thoughts, tools) {
    if (!activity) {
      activity = {
        key: 'activity:' + item.entry.id,
        items: [],
        thinking: 0,
        toolCount: 0,
        failures: 0,
        latestTool: '',
        outputs: [],
        needsResponse: false,
        startedAt: turnStartedAt || entryTime(item.entry),
        endedAt: 0,
      };
      sections.push(activity);
    }
    activity.items.push(item);
    activity.endedAt = Math.max(activity.endedAt, entryTime(item.entry));
    activity.thinking += thoughts;
    activity.toolCount += tools.length;
    for (const tool of tools) {
      activity.latestTool = tool.name;
      if (results.get(tool.id)?.isError) activity.failures++;
    }
  }

  for (let item of entries) {
    const { entry } = item;
    const message = entry.type === 'message' && entry.message;
    if (
      message?.role === 'toolResult' ||
      entry.type === 'thinking_level_change' ||
      entry.type === 'session_info' ||
      (entry.type === 'model_change' && entry.implicit)
    )
      continue;
    if (message?.role === 'user') {
      activity = null;
      turnStartedAt = entryTime(entry);
    }
    if (message?.role === 'assistant' && !item.repeatedError) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const tools = blocks.filter((block) => block.type === 'toolCall');
      const thoughtCount = blocks.filter(
        (block) => block.type === 'thinking' && block.thinking?.trim(),
      ).length;
      const final = item.reply || ['aborted', 'error'].includes(message.stopReason);
      if (!final && (tools.length || thoughtCount || message.stopReason === 'toolUse')) {
        addActivity(item, thoughtCount, tools);
        activity.outputs.push(...(outputsByEntry?.get(entry.id) || []));
        activity.needsResponse ||= tools.some((tool) =>
          questionNeedsResponse(tool.name, results.get(tool.id)),
        );
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

  for (const section of sections) {
    if (section.items) section.durationMs = Math.max(0, section.endedAt - section.startedAt);
  }
  if (activity) {
    activity.running = running;
    activity.required = activity.needsResponse;
  }
  return sections;
}

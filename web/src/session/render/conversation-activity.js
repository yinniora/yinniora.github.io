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
  function addActivity(item, thoughts, tools) {
    if (!activity) {
      activity = {
        key: 'activity:' + item.entry.id + (item.toolBlocks ? ':tools' : ''),
        items: [],
        thinking: 0,
        toolCount: 0,
        failures: 0,
        latestTool: '',
      };
      sections.push(activity);
    }
    activity.items.push(item);
    activity.thinking += thoughts;
    activity.toolCount += tools.length;
    for (const tool of tools) {
      activity.latestTool = tool.name;
      if (results.get(tool.id)?.isError) activity.failures++;
    }
  }

  for (const row of entries) {
    let item = row;
    let followingTools = [];
    const { entry } = item;
    const message = entry.type === 'message' && entry.message;
    if (
      message?.role === 'toolResult' ||
      entry.type === 'thinking_level_change' ||
      entry.type === 'session_info' ||
      (entry.type === 'model_change' && entry.implicit)
    )
      continue;
    if (message?.role === 'assistant' && Array.isArray(message.content) && !item.repeatedError) {
      const tools = message.content.filter((block) => block.type === 'toolCall');
      const thoughts = message.content.filter(
        (block) => block.type === 'thinking' && block.thinking?.trim(),
      );
      const hasText = message.content.some((block) => block.type === 'text' && block.text?.trim());
      const hasBody =
        item.reply ||
        outputsByEntry?.get(entry.id)?.length ||
        ['aborted', 'error'].includes(message.stopReason) ||
        hasText;
      const requiresAnswer = tools.some((tool) =>
        questionNeedsResponse(tool.name, results.get(tool.id)),
      );
      if (!hasBody && !requiresAnswer && (tools.length || thoughts.length)) {
        addActivity(item, thoughts.length, tools);
        continue;
      }
      // Leading thinking belongs with the adjacent activity, even when Pi
      // stores it in the same entry as the visible reply.
      const leading = message.content.findIndex(
        (block) => block.type !== 'thinking' && !(block.type === 'text' && !block.text?.trim()),
      );
      const blockCount = leading < 0 ? message.content.length : leading;
      const visibleThoughts = message.content
        .slice(0, blockCount)
        .filter((block) => block.type === 'thinking' && block.thinking?.trim());
      if (visibleThoughts.length) {
        addActivity({ ...item, leadingThinking: blockCount }, visibleThoughts.length, []);
        item = { ...item, skipThinking: blockCount };
      }
      if (tools.length && !requiresAnswer) {
        item = { ...item, skipTools: true };
        if (hasText && !item.reply && message.stopReason !== 'error') {
          followingTools = tools;
        } else {
          addActivity({ entry, toolBlocks: tools }, 0, tools);
        }
      }
    }
    activity = null;
    sections.push({ key: entry.id, item });
    if (followingTools.length) {
      addActivity({ entry, toolBlocks: followingTools }, 0, followingTools);
    }
  }

  const tail = sections.at(-1);
  if (tail?.items) tail.running = running;
  return sections;
}

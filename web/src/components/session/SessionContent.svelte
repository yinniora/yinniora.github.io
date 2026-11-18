<script>
  // The message pane: renders the active root→leaf path from the reactive model
  // as <SessionEntry> components, replacing the navigator's imperative #messages
  // build. Keyed by entry id so navigation and live reload add/update/remove
  // entries reactively. `afterRender(container)` runs after each (re)render to
  // re-apply toggle state, lazy-highlight pending code, and scroll — concerns the
  // imperative layer still owns. Shared by the live app + the static export.
  import { getSessionModel } from '../../session/session-context.js';
  import SessionEntry from './SessionEntry.svelte';
  import AssistantThinking from './AssistantThinking.svelte';
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  import ToolCall from './ToolCall.svelte';
  import { entriesWithReplyDetails } from '../../session/render/reply-details.js';
  import { groupOutputsByReply } from '../../session/artifacts/outputs.js';
  import { groupConversationActivity } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';

  let {
    model = getSessionModel(),
    afterRender = null,
    live = false,
    chatAvailable = false,
    sessionRunning = false,
    outputs = [],
    renderOutputs = null,
  } = $props();

  let containerEl = $state(null);
  const entries = $derived(
    live ? entriesWithReplyDetails(model.activePath) : model.activePath.map((entry) => ({ entry })),
  );
  const groups = $derived(outputs.length ? groupOutputsByReply(entries, outputs) : null);
  const sections = $derived(
    live
      ? groupConversationActivity(entries, groups?.byEntry, sessionRunning)
      : entries.map((item) => ({ key: item.entry.id, item })),
  );

  // Re-run post-render side effects whenever the rendered path changes.
  $effect(() => {
    sections;
    if (containerEl && typeof afterRender === 'function') {
      afterRender(containerEl);
    }
  });
</script>

{#snippet renderEntry({ entry, reply, repeatedError, retryContent, skipThinking, skipTools })}
  {#if repeatedError}
    <span id={`entry-${entry.id}`} hidden></span>
  {:else}
    <SessionEntry
      {entry}
      {reply}
      {model}
      {live}
      {chatAvailable}
      {retryContent}
      {skipThinking}
      {skipTools}
      outputs={groups?.byEntry.get(entry.id)}
      {renderOutputs}
    />
  {/if}
{/snippet}

<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each sections as section (section.key)}
    {#if section.items}
      <ActivityDisclosure
        kind="group"
        id={section.key}
        label={section.thinking && section.toolCount
          ? t('activity.thinking') + ' · ' + t('activity.tools')
          : t(section.thinking ? 'activity.thinking' : 'activity.tools')}
        count={section.toolCount}
        summary={section.failures
          ? t('activity.failed') + ' ' + section.failures
          : section.running
            ? section.latestTool
            : ''}
        status={section.running ? 'pending' : section.failures ? 'error' : 'success'}
      >
        {#each section.items as item (item.entry.id + (item.toolBlocks ? ':tools' : ''))}
          {#if item.toolBlocks}
            {#each item.toolBlocks as call, index (index)}
              <ToolCall {call} {model} live />
            {/each}
          {:else if item.leadingThinking}
            {#each item.entry.message.content.slice(0, item.leadingThinking) as block, index (index)}
              {#if block.type === 'thinking' && block.thinking?.trim()}
                <AssistantThinking
                  id={`thinking:${item.entry.id}:${index}`}
                  text={block.thinking}
                  live
                />
              {/if}
            {/each}
          {:else}
            {@render renderEntry(item)}
          {/if}
        {/each}
      </ActivityDisclosure>
    {:else}
      {@render renderEntry(section.item)}
    {/if}
  {/each}
  {#if groups?.unassigned.length}
    {@render renderOutputs?.(groups.unassigned)}
  {/if}
</div>

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
  import ToolRun from './ToolRun.svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { entriesWithReplyDetails } from '../../session/render/reply-details.js';
  import { groupOutputsByReply } from '../../session/artifacts/outputs.js';
  import { groupConversationActivity } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';
  import { formatElapsed } from '../../session/render/entry-format.js';

  // Titled like "Worked for 1m 12s · 3 tool calls": the turn's duration says
  // more than a generic "Tool calls" label.
  const md = (text) => safeMarkedParse(text, { marked });

  function activityText(section) {
    const tools = section.toolCount ? t('activity.toolCount', { count: section.toolCount }) : '';
    const failed = section.failures ? t('activity.failed') + ' ' + section.failures : '';
    if (section.running)
      return { label: t('activity.working'), summary: failed || section.latestTool };
    if (section.unfinished)
      return {
        label: t(section.lastStop === 'length' ? 'activity.truncated' : 'activity.unfinished'),
        summary: [formatElapsed(section.durationMs), tools, failed].filter(Boolean).join(' · '),
      };
    if (section.durationMs >= 1000)
      return {
        label: t('activity.worked', { duration: formatElapsed(section.durationMs) }),
        summary: failed || tools,
      };
    return { label: tools || t('activity.thinking'), summary: failed };
  }

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

{#snippet renderEntry(
  { entry, reply, repeatedError, retryContent, skipActivity },
  inActivity = false,
)}
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
      {skipActivity}
      outputs={inActivity ? undefined : groups?.byEntry.get(entry.id)}
      {renderOutputs}
    />
  {/if}
{/snippet}

<!-- eslint-disable svelte/no-at-html-tags -- trusted: sanitized session markdown -->
<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each sections as section (section.key)}
    {#if section.items}
      <ActivityDisclosure
        kind="group"
        id={section.key}
        label={activityText(section).label}
        count={section.running ? section.toolCount : 0}
        summary={activityText(section).summary}
        required={section.required}
        running={section.running}
        unfinished={section.unfinished}
        status={section.running
          ? 'pending'
          : section.unfinished
            ? 'stopped'
            : section.failures
              ? 'error'
              : 'success'}
      >
        {#each section.timeline as step (step.key)}
          {#each step.anchors || [] as anchor (anchor)}<span
              id={`entry-${anchor}`}
              class="activity-anchor"
            ></span>{/each}
          {#if step.kind === 'text'}
            <div class="activity-step-text markdown-content">{@html md(step.text)}</div>
          {:else if step.kind === 'thinking'}
            <AssistantThinking id={`thinking:${step.key}`} text={step.text} live />
          {:else if step.kind === 'question'}
            <ToolCall call={step.call} {model} live />
          {:else}
            <ToolRun run={step} {model} />
          {/if}
        {/each}
      </ActivityDisclosure>
      {#if section.outputs.length}
        {@render renderOutputs?.(section.outputs)}
      {/if}
    {:else}
      {@render renderEntry(section.item)}
    {/if}
  {/each}
  {#if groups?.unassigned.length}
    {@render renderOutputs?.(groups.unassigned)}
  {/if}
</div>

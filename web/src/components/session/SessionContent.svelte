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
  import ReplyError from './ReplyError.svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { entriesWithReplyDetails } from '../../session/render/reply-details.js';
  import { groupOutputsByReply } from '../../session/artifacts/outputs.js';
  import { groupConversationActivity } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';
  import { icon, ChevronRight } from '../../shared/icons.js';
  import { formatElapsed } from '../../session/render/entry-format.js';

  // Titled like "Worked for 1m 12s · 3 tool calls": the turn's duration says
  // more than a generic "Tool calls" label.
  const md = (text) => safeMarkedParse(text, { marked });

  function activityText(section) {
    const tools = section.toolCount ? t('activity.toolCount', { count: section.toolCount }) : '';
    const failed = section.failures ? t('activity.failed') + ' ' + section.failures : '';
    const retries = section.retries ? t('activity.retryCount', { count: section.retries }) : '';
    if (section.required) return { label: t('piExtension.waiting'), summary: tools };
    if (section.running)
      return {
        label: t('activity.working'),
        summary: [tools, failed, retries].filter(Boolean).join(' · '),
      };
    if (section.unfinished)
      return {
        label: t('activity.unfinished'),
        summary: [formatElapsed(section.durationMs), tools, failed].filter(Boolean).join(' · '),
      };
    if (section.durationMs >= 1000)
      return {
        label: t('activity.worked', { duration: formatElapsed(section.durationMs) }),
        summary: [
          failed || tools,
          retries,
          section.steered && t('activity.steered'),
          section.autoContinued && t('activity.autoContinued'),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    return { label: tools || retries || t('activity.thinking'), summary: failed };
  }

  let {
    model = getSessionModel(),
    afterRender = null,
    live = false,
    chatAvailable = false,
    sessionRunning = false,
    thinkingPreviews = [],
    outputs = [],
    renderOutputs = null,
    onCompact = null,
  } = $props();

  let containerEl = $state(null);
  const entries = $derived(
    live
      ? entriesWithReplyDetails(model.activePath, { running: sessionRunning })
      : model.activePath.map((entry) => ({ entry })),
  );
  const groups = $derived(outputs.length ? groupOutputsByReply(entries, outputs) : null);
  const sections = $derived(
    live
      ? groupConversationActivity(entries, groups?.byEntry, sessionRunning, thinkingPreviews)
      : entries.map((item) => ({ key: item.entry.id, item })),
  );
  // Sections after the last user message belong to the newest turn; only that
  // turn offers to continue with another model or effort.
  const latestFrom = $derived.by(() => {
    for (let index = sections.length - 1; index >= 0; index--) {
      const item = sections[index].item;
      if (item?.entry.message?.role === 'user' && !item.autoContinued) return index + 1;
    }
    return 0;
  });
  function continueTask() {
    document
      .getElementById('pi-chat-composer')
      ?.dispatchEvent(new CustomEvent('pi:retry-prompt', { detail: t('activity.continuePrompt') }));
  }
  function chooseModel(event) {
    event.stopPropagation();
    document.getElementById('pi-chat-model-label')?.click();
  }

  // Re-run post-render side effects whenever the rendered path changes.
  $effect(() => {
    entries;
    sessionRunning;
    outputs;
    if (containerEl && typeof afterRender === 'function') {
      afterRender(containerEl);
    }
  });
</script>

{#snippet renderEntry(
  {
    entry,
    reply,
    repeatedError,
    retried,
    autoContinued,
    retryContent,
    canResumeNetworkFailure,
    skipActivity,
    emptyReply,
  },
  inActivity = false,
  latestTurn = false,
)}
  {#if repeatedError || retried || autoContinued}
    <span id={`entry-${entry.id}`} hidden></span>
  {:else}
    <SessionEntry
      {entry}
      {reply}
      {model}
      {live}
      {chatAvailable}
      {retryContent}
      {canResumeNetworkFailure}
      {emptyReply}
      {latestTurn}
      {skipActivity}
      outputs={inActivity ? undefined : groups?.byEntry.get(entry.id)}
      {renderOutputs}
      {onCompact}
    />
  {/if}
{/snippet}

<!-- eslint-disable svelte/no-at-html-tags -- trusted: sanitized session markdown -->
<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each sections as section, sectionIndex (section.key)}
    {#if section.items}
      <ActivityDisclosure
        kind="group"
        id={section.key}
        label={activityText(section).label}
        summary={activityText(section).summary}
        required={section.required}
        running={section.running}
        unfinished={section.unfinished}
        status={section.running || section.required
          ? 'pending'
          : section.questionOutcome ||
            (section.unfinished ? 'stopped' : section.failures ? 'error' : 'success')}
      >
        {#each section.timeline as step (step.key)}
          {#each step.anchors || [] as anchor (anchor)}<span
              id={`entry-${anchor}`}
              class="activity-anchor"
            ></span>{/each}
          {#if step.kind === 'text'}
            <div class="activity-step-text markdown-content">{@html md(step.text)}</div>
          {:else if step.kind === 'thinking'}
            <AssistantThinking
              id={`thinking:${step.key}`}
              text={step.text}
              liveText={step.liveText}
              running={section.running}
              streaming={!!step.streaming}
              live
            />
          {:else if step.kind === 'question'}
            <ToolCall call={step.call} {model} live />
          {:else}
            <ToolRun run={step} {model} />
          {/if}
        {/each}
      </ActivityDisclosure>
      {#if section.unfinished && chatAvailable && !sessionRunning && sectionIndex >= latestFrom}
        <ReplyError actionsOnly onContinue={continueTask} onChooseModel={chooseModel} />
      {/if}
      {#if section.outputs.length}
        {@render renderOutputs?.(section.outputs)}
      {/if}
    {:else}
      {@render renderEntry(section.item, false, !sessionRunning && sectionIndex >= latestFrom)}
    {/if}
  {/each}
  {#if groups?.unassigned.length && sessionRunning}
    {@render renderOutputs?.(groups.unassigned)}
  {/if}
  <!-- After the turn ends, every file the session produced is also collected
       into one collapsible card at the end; the inline cards above stay where
       they were produced and scroll with the conversation. -->
  {#if !sessionRunning && outputs.length > 0}
    <details class="outputs-card" data-output-count={outputs.length}>
      <summary>
        <span class="outputs-card-chevron" aria-hidden="true"
          >{@html icon(ChevronRight, { size: 14 })}</span
        >{t('session.outputsSummary', { count: outputs.length })}
      </summary>
      <div class="outputs-card-body">{@render renderOutputs?.(outputs)}</div>
    </details>
  {/if}
</div>

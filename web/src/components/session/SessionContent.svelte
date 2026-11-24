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
  import ToolImageStrip from './ToolImageStrip.svelte';
  import ReplyError from './ReplyError.svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { entriesWithReplyDetails } from '../../session/render/reply-details.js';
  import { groupOutputsByReply, indexOutputFiles } from '../../session/artifacts/outputs.js';
  import { collectToolFileOperations } from '../../session/artifacts/tool-files.js';
  import { groupConversationActivity } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';
  import { FileText, Image, Pencil, Wrench } from '../../shared/icons.js';
  import { formatElapsed } from '../../session/render/entry-format.js';

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
    outputsReady = true,
    renderOutputs = null,
    onCompact = null,
    cwd = '',
    sessionId = '',
  } = $props();

  const md = (text) => safeMarkedParse(text, { marked, workspaceCwd: live ? cwd : undefined });
  let containerEl = $state(null);
  const entries = $derived(
    live
      ? entriesWithReplyDetails(model.activePath, { running: sessionRunning })
      : model.activePath.map((entry) => ({ entry })),
  );
  const groups = $derived(outputs.length ? groupOutputsByReply(entries, outputs) : null);
  const replyFileIndex = $derived(live ? indexOutputFiles(outputs, cwd) : null);
  const toolFiles = $derived(
    live ? collectToolFileOperations(model.activePath, cwd, sessionId) : null,
  );
  const workspacePreviews = new Map();
  const sections = $derived(
    live
      ? groupConversationActivity(entries, sessionRunning, thinkingPreviews, toolFiles)
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
      showEmptyReplyWarning={!latestTurn || (sessionRunning === false && outputsReady)}
      latestTurn={latestTurn && sessionRunning === false}
      {skipActivity}
      outputs={groups?.byEntry.get(entry.id)}
      {replyFileIndex}
      {renderOutputs}
      {onCompact}
      {cwd}
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
          {:else if step.kind === 'files'}
            {@const operation = step.operation}
            {@const images = operation.images.length > 0}
            {@const label =
              operation.action === 'other'
                ? t('toolImages.other')
                : t((images ? 'toolImages.' : 'toolFiles.') + operation.action)}
            {@const summary = [...operation.images, ...operation.files]
              .map((file) => file.title)
              .filter(Boolean)
              .join(' · ')}
            <ActivityDisclosure
              kind="file"
              id={step.key}
              entryId={operation.resultId}
              {label}
              summary={summary || step.call.name.split('__').at(-1)}
              glyph={operation.action === 'edit'
                ? Pencil
                : images
                  ? Image
                  : operation.action === 'other'
                    ? Wrench
                    : FileText}
              status={operation.failed ? 'error' : ''}
              deferBody
            >
              {#if images}<ToolImageStrip images={operation.images} {workspacePreviews} />{/if}
              {#if operation.files.length}{@render renderOutputs?.(operation.files, false)}{/if}
              <ToolCall call={step.call} {model} live resultAnchor={false} />
            </ActivityDisclosure>
          {:else}
            <ToolRun run={step} {model} />
          {/if}
        {/each}
      </ActivityDisclosure>
      {#if section.unfinished && chatAvailable && sessionRunning === false && sectionIndex >= latestFrom}
        <ReplyError actionsOnly onContinue={continueTask} onChooseModel={chooseModel} />
      {/if}
    {:else}
      {@render renderEntry(section.item, sectionIndex >= latestFrom)}
    {/if}
  {/each}
</div>

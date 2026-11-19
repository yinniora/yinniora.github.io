<script>
  // One conversation entry in the message pane, rendered declaratively (the
  // decomposition of the former renderEntry()). {@html} is used only for markdown
  // (safeMarkedParse) — everything else is escaped Svelte template. The wrapper
  // keeps its `entry-<id>` anchor so annotation offsets + scroll/toggle survive.
  // Shared by the live app and the static export (model passed as a prop).
  import { marked } from 'marked';
  import { icon, Ellipsis, GitFork, Link2, Tag } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import {
    formatTimestamp,
    formatShortTime,
    stripImageNotes,
  } from '../../session/render/entry-format.js';
  import ToolCall from './ToolCall.svelte';
  import AssistantThinking from './AssistantThinking.svelte';
  import ReplyFooter from './ReplyFooter.svelte';
  import CopyMessageButton from './CopyMessageButton.svelte';
  import ReplyError from './ReplyError.svelte';
  import ToolOutput from './ToolOutput.svelte';

  // `live` (passed from <SessionContent>) gates the fork/label buttons, which
  // need the chat composer; copy-link is always shown. The static export passes
  // false. (Replaces the former renderForkButton/renderLabelButton isLive check —
  // a prop, not a DOM probe, since entries mount before the composer.)
  let {
    entry,
    reply = null,
    model = null,
    live = false,
    chatAvailable = false,
    retryContent = null,
    skipActivity = false,
    outputs,
    renderOutputs = null,
  } = $props();

  const ts = $derived(formatTimestamp(entry?.timestamp));
  const md = (text) => safeMarkedParse(text, { marked });

  const msg = $derived(entry?.type === 'message' ? entry.message : null);
  const assistantContent = $derived(
    typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : msg?.content || [],
  );
  const activityOnly = $derived(
    live &&
      !reply &&
      !outputs?.length &&
      msg?.stopReason !== 'error' &&
      msg?.stopReason !== 'aborted' &&
      assistantContent.some((block) => block.type === 'toolCall' || block.thinking?.trim()) &&
      !assistantContent.some((block) => block.type === 'text' && block.text?.trim()),
  );
  const userText = $derived.by(() => {
    if (!msg || msg.role !== 'user') return '';
    const c = msg.content;
    return typeof c === 'string'
      ? c
      : c
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  });
  const userDisplayText = $derived(stripImageNotes(userText));
  const userTime = $derived(live && msg?.role === 'user' ? formatShortTime(entry?.timestamp) : '');
  const userImages = $derived(
    Array.isArray(msg?.content) ? msg.content.filter((b) => b.type === 'image') : [],
  );

  function chooseModel(event) {
    event.stopPropagation();
    document.getElementById('pi-chat-model-label')?.click();
  }
  const retry = () =>
    document
      .getElementById('pi-chat-composer')
      ?.dispatchEvent(new CustomEvent('pi:retry-prompt', { detail: retryContent }));
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#snippet actions(id)}
  {#if live}<button class="fork-btn" data-entry-id={id} title="Fork session from this message"
      >{@html icon(GitFork, { size: 13 })}</button
    >{/if}
  {#if live}<button
      class="label-btn"
      data-entry-id={id}
      title={t('session.labelEntry')}
      aria-label={t('session.labelEntry')}>{@html icon(Tag, { size: 13 })}</button
    >{/if}
  <button class="copy-link-btn" data-entry-id={id} title="Copy link to this message"
    >{@html icon(Link2, { size: 14 })}</button
  >
{/snippet}
{#snippet entryMenu(id)}
  <details class="entry-actions-menu" name="entry-actions">
    <summary aria-label={t('palette.actions')}>{@html icon(Ellipsis, { size: 16 })}</summary>
    <div
      class="entry-action-buttons"
      role="presentation"
      onclick={(event) => {
        if (event.target.closest('button')) event.currentTarget.closest('details').open = false;
      }}
    >
      {@render actions(id)}
    </div>
  </details>
{/snippet}
{#snippet timestamp()}{#if ts}<div class="message-timestamp">{ts}</div>{/if}{/snippet}

{#if msg && msg.role === 'user'}
  <div class="user-message" id={`entry-${entry.id}`}>
    {#if !live}{@render actions(entry.id)}{/if}{@render timestamp()}
    {#if userImages.length > 0}<div class="message-images">
        {#each userImages as img, imgIndex (imgIndex)}<img
            src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
            class="message-image"
            alt=""
          />{/each}
      </div>{/if}
    {#if userDisplayText.trim()}<div class="markdown-content">{@html md(userDisplayText)}</div>{/if}
  </div>
  {#if live}
    <div class="message-copy-row">
      {#if userTime}<time
          class="message-copy-time"
          datetime={new Date(entry.timestamp).toISOString()}
          title={new Date(entry.timestamp).toLocaleString()}>{userTime}</time
        >{/if}
      {#if userDisplayText.trim()}<CopyMessageButton text={userDisplayText} iconOnly />{/if}
      {@render entryMenu(entry.id)}
    </div>
  {/if}
{:else if msg && msg.role === 'assistant'}
  <div
    class="assistant-message"
    class:assistant-activity-only={activityOnly}
    id={`entry-${entry.id}`}
  >
    {#if !live}{@render actions(entry.id)}{/if}
    {#if !reply}{@render timestamp()}{/if}
    {#each assistantContent as block, blockIndex (blockIndex)}
      {#if block.type === 'text' && block.text.trim()}<div class="assistant-text markdown-content">
          {@html md(block.text)}
        </div>{:else if !skipActivity && block.type === 'thinking' && block.thinking?.trim()}
        <AssistantThinking id={`thinking:${entry.id}:${blockIndex}`} text={block.thinking} {live} />
      {/if}
    {/each}
    {#if !skipActivity}
      {#each assistantContent as block, toolBlockIndex (toolBlockIndex)}{#if block.type === 'toolCall'}<ToolCall
            call={block}
            {model}
            {live}
          />{/if}{/each}
    {/if}
    {#if msg.stopReason === 'aborted'}
      {#if live}
        <ReplyError interrupted onRetry={chatAvailable && retryContent ? retry : null} />
      {:else}
        <div class="error-text">{t('activity.interrupted')}</div>
      {/if}
    {:else if msg.stopReason === 'error'}
      {#if live}
        <ReplyError
          error={msg.errorMessage || t('activity.failed')}
          model={[msg.provider, msg.model].filter(Boolean).join('/')}
          onChooseModel={chatAvailable ? chooseModel : null}
          onRetry={chatAvailable && retryContent ? retry : null}
        />
      {:else}
        <div class="error-text">Error: {msg.errorMessage || 'Unknown error'}</div>
      {/if}
    {/if}
    {#if outputs?.length}
      {@render renderOutputs?.(outputs)}
    {/if}
    {#if reply}
      <ReplyFooter {...reply}>
        {#snippet menu()}{#if live}{@render entryMenu(entry.id)}{/if}{/snippet}
      </ReplyFooter>
    {:else if live}
      {@render entryMenu(entry.id)}
    {/if}
  </div>
{:else if msg && msg.role === 'bashExecution'}
  <div
    class="tool-execution {msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null)
      ? 'error'
      : 'success'}"
    id={`entry-${entry.id}`}
  >
    {@render timestamp()}
    <div class="tool-command">$ {msg.command}</div>
    {#if msg.output}<ToolOutput text={msg.output} maxLines={10} />{/if}
    {#if msg.cancelled}<div style="color: var(--warning)">
        (cancelled)
      </div>{:else if msg.exitCode !== 0 && msg.exitCode !== null}<div style="color: var(--error)">
        (exit {msg.exitCode})
      </div>{/if}
  </div>
{:else if entry?.type === 'model_change' && !entry.implicit}
  <div class="model-change" id={`entry-${entry.id}`}>
    {@render timestamp()}Switched to model:
    <span class="model-name">{entry.provider}/{entry.modelId}</span>
  </div>
{:else if entry?.type === 'compaction'}
  <div
    class="compaction"
    id={`entry-${entry.id}`}
    onclick={(e) => {
      if (window.getSelection && window.getSelection().toString()) return;
      e.currentTarget.classList.toggle('expanded');
    }}
    role="presentation"
  >
    <div class="compaction-label">[compaction]</div>
    <div class="compaction-collapsed">
      Compacted from {entry.tokensBefore.toLocaleString()} tokens
    </div>
    <div class="compaction-content">
      <strong>Compacted from {entry.tokensBefore.toLocaleString()} tokens</strong
      >{'\n\n'}{entry.summary}
    </div>
  </div>
{:else if entry?.type === 'branch_summary'}
  <div class="branch-summary" id={`entry-${entry.id}`}>
    {@render timestamp()}
    <div class="branch-summary-header">Branch Summary</div>
    <div class="markdown-content">{@html md(entry.summary)}</div>
  </div>
{:else if entry?.type === 'custom_message' && entry.display}
  <div class="hook-message" id={`entry-${entry.id}`}>
    {@render timestamp()}
    <div class="hook-type">[{entry.customType}]</div>
    <div class="markdown-content">
      {@html md(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}
    </div>
  </div>
{/if}

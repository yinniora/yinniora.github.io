<script>
  // The message pane: renders the active root→leaf path from the reactive model
  // as <SessionEntry> components, replacing the navigator's imperative #messages
  // build. Keyed by entry id so navigation and live reload add/update/remove
  // entries reactively. `afterRender(container)` runs after each (re)render to
  // re-apply toggle state, lazy-highlight pending code, and scroll — concerns the
  // imperative layer still owns. Shared by the live app + the static export.
  import { getSessionModel } from '../../session/session-context.js';
  import SessionEntry from './SessionEntry.svelte';
  import { entriesWithReplyDetails } from '../../session/render/reply-details.js';
  import { groupOutputsByReply } from '../../session/artifacts/outputs.js';

  let {
    model = getSessionModel(),
    afterRender = null,
    live = false,
    chatAvailable = false,
    outputs = [],
    renderOutputs = null,
  } = $props();

  let containerEl = $state(null);
  const entries = $derived(
    live ? entriesWithReplyDetails(model.activePath) : model.activePath.map((entry) => ({ entry })),
  );
  const groups = $derived(outputs.length ? groupOutputsByReply(entries, outputs) : null);

  // Re-run post-render side effects whenever the rendered path changes.
  $effect(() => {
    model.activePath;
    if (containerEl && typeof afterRender === 'function') {
      afterRender(containerEl);
    }
  });
</script>

<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each entries as { entry, reply, repeatedError, retryContent } (entry.id)}
    {#if repeatedError}
      <span id={`entry-${entry.id}`} hidden></span>
    {:else}<SessionEntry
        {entry}
        {reply}
        {model}
        {live}
        {chatAvailable}
        {retryContent}
        outputs={groups?.byEntry.get(entry.id)}
        {renderOutputs}
      />{/if}
  {/each}
  {#if groups?.unassigned.length}
    {@render renderOutputs?.(groups.unassigned)}
  {/if}
</div>

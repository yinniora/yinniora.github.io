<script>
  // A run of consecutive tool calls in an activity group, shown as one line
  // ("Ran 3 commands, read 2 files"), Codex-style. While a call is pending the
  // line names it; expanding shows each call in full.
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  import ToolCall from './ToolCall.svelte';
  import { toolKind } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';
  import {
    Terminal,
    FileText,
    Pencil,
    Search,
    Globe,
    MousePointerClick,
    Wrench,
  } from '../../shared/icons.js';

  const glyphs = {
    command: Terminal,
    read: FileText,
    edit: Pencil,
    search: Search,
    web: Globe,
    ui: MousePointerClick,
    other: Wrench,
  };
  function target(call) {
    const args = call?.arguments || {};
    const value =
      args.command || args.file_path || args.path || args.pattern || args.query || args.url || '';
    return String(value).trim().split('\n')[0];
  }

  let { run, model } = $props();

  const order = ['command', 'read', 'edit', 'search', 'web', 'ui', 'other'];
  const label = $derived.by(() => {
    const parts = order
      .filter((kind) => run.counts[kind])
      .map((kind) => t('toolRun.' + kind, { count: run.counts[kind] }));
    if (run.pending) {
      const kind = toolKind(run.pending.name);
      return {
        label: t('toolRun.now.' + kind, { name: run.pending.name }),
        summary: target(run.pending),
        glyph: glyphs[kind],
      };
    }
    // Name what ran when it is a single call; a longer run reads from its label.
    const kinds = order.filter((kind) => run.counts[kind]);
    return {
      label: parts.join(t('toolRun.separator')) || run.calls[0]?.name,
      summary: run.calls.length === 1 ? target(run.calls[0]) : '',
      glyph: glyphs[kinds.length === 1 ? kinds[0] : 'other'],
    };
  });
</script>

<ActivityDisclosure
  kind="tool-run"
  id={run.key}
  label={label.label}
  summary={run.failures ? t('activity.failed') + ' ' + run.failures : label.summary}
  glyph={label.glyph}
  status={run.pending ? 'pending' : run.failures ? 'error' : ''}
>
  {#each run.calls as call (call.id)}
    <ToolCall {call} {model} live />
  {/each}
</ActivityDisclosure>

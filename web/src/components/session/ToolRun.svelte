<script>
  // A run of consecutive tool calls in an activity group, shown as one line
  // ("Ran 3 commands, read 2 files"), Codex-style. While a call is pending the
  // line names it; expanding shows each call in full.
  import ActivityDisclosure from './ActivityDisclosure.svelte';
  import ToolCall from './ToolCall.svelte';
  import { toolKind } from '../../session/render/conversation-activity.js';
  import { t } from '../../shared/i18n.js';

  let { run, model } = $props();

  const order = ['command', 'read', 'edit', 'search', 'web', 'ui', 'other'];
  const label = $derived.by(() => {
    const parts = order
      .filter((kind) => run.counts[kind])
      .map((kind) => t('toolRun.' + kind, { count: run.counts[kind] }));
    if (run.pending) {
      const kind = toolKind(run.pending.name);
      const args = run.pending.arguments || {};
      const target = args.command || args.file_path || args.path || args.pattern || args.url || '';
      return {
        label: t('toolRun.now.' + kind, { name: run.pending.name }),
        summary: String(target).split('\n')[0],
        done: parts.join(t('toolRun.separator')),
      };
    }
    return { label: parts.join(t('toolRun.separator')) || run.calls[0]?.name, summary: '' };
  });
</script>

<ActivityDisclosure
  kind="tool-run"
  id={run.key}
  label={label.label}
  summary={label.summary || (run.failures ? t('activity.failed') + ' ' + run.failures : '')}
  status={run.pending ? 'pending' : run.failures ? 'error' : ''}
>
  {#each run.calls as call (call.id)}
    <ToolCall {call} {model} live />
  {/each}
</ActivityDisclosure>

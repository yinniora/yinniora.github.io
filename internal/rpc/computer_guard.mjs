const computerTools = new Set([
  'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
  'read_text', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser',
  'computer_use', 'computer',
]);

export default function guardComputerTools(pi) {
  pi.registerCommand('yugo-computer-guard-ready', {
    description: 'YuGo Pi computer approval is active',
    handler: async () => {},
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!computerTools.has(event.toolName)) return;
    const request = JSON.stringify({
      tool: event.toolName,
      detail: JSON.stringify(event.input ?? {}).slice(0, 1200),
    });
    const approved = await ctx.ui.confirm('YuGo Pi computer approval', request, { timeout: 45000, signal: ctx.signal });
    if (!approved) return { block: true, terminate: true, reason: 'The user did not approve this computer action.' };
  });
}

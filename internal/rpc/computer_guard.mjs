const computerTools = new Set([
  'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
  'read_text', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser',
  'computer_use', 'computer',
]);
const defaultShellTimeoutSeconds = 300;

export default function guardComputerTools(pi) {
  pi.registerCommand('yugo-computer-guard-ready', {
    description: 'YuGo Pi computer approval is active',
    handler: async () => {},
  });
  pi.on('before_provider_headers', (event, ctx) => {
    if (ctx.model?.api !== 'anthropic-messages') return;
    const headers = event.headers;
    const authorization = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
    const apiKey = Object.keys(headers).find((name) => name.toLowerCase() === 'x-api-key') || 'x-api-key';
    const bearer = authorization && headers[authorization];
    if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && (!headers[apiKey] || bearer === `Bearer ${headers[apiKey]}`)) {
      headers[apiKey] = null;
    }
  });
  pi.on('tool_call', (event) => {
    if ((event.toolName === 'bash' || event.toolName === 'powershell') && event.input.timeout === undefined) {
      event.input.timeout = defaultShellTimeoutSeconds;
    }
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

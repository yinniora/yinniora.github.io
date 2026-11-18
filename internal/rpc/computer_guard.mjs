const computerTools = new Set([
  'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
  'read_text', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser',
  'computer_use', 'computer',
]);
const defaultShellTimeoutSeconds = 300;
const approvalTimeoutMs = 120000;

export default function guardComputerTools(pi) {
  let skipComputerTools = false;
  pi.on('agent_start', () => {
    skipComputerTools = false;
  });
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
    const guidance = 'Continue any remaining work that does not require this computer action. Do not retry or perform the blocked action through another tool. If computer access is essential, explain what remains blocked and ask the user.';
    if (skipComputerTools) {
      return { block: true, reason: `Computer tools are unavailable for the rest of this turn after an unapproved action. ${guidance}` };
    }
    const request = JSON.stringify({
      tool: event.toolName,
      detail: JSON.stringify(event.input ?? {}).slice(0, 1200),
    });
    const start = Date.now();
    const approved = await ctx.ui.confirm('YuGo Pi computer approval', request, { timeout: approvalTimeoutMs, signal: ctx.signal });
    if (!approved) {
      skipComputerTools = true;
      const reason = Date.now() - start >= approvalTimeoutMs
        ? 'Approval timed out for this computer action.'
        : 'This computer action was not approved.';
      return { block: true, reason: `${reason} ${guidance}` };
    }
  });
}

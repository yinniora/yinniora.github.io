import { createHash } from 'node:crypto';

const computerTools = new Set([
  'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
  'read_text', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser',
  'computer_use', 'computer',
]);
const defaultShellTimeoutSeconds = 300;
const approvalTimeoutMs = 120000;
const deniedGuidance = 'Do not retry or use another tool for the blocked action. Continue unrelated work.';
const approvalReasons = {
  cancelled: 'This computer action was cancelled.',
  off: 'Computer control is off for this conversation.',
  declined: 'This computer action was declined.',
  repeated: 'This computer action was declined.',
};

function orderedArguments(_key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]]));
}

export default function guardComputerTools(pi) {
  pi.on('before_agent_start', ({ systemPrompt }) => ({
    systemPrompt: systemPrompt + '\n\nUse the registered computer tools when needed. Each action follows the current session approval policy. An earlier denial applies to that attempt only.',
  }));
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
    const detail = JSON.stringify(event.input ?? {}, orderedArguments, 2);
    const request = JSON.stringify({
      tool: event.toolName,
      detail: detail.length > 1200 ? detail.slice(0, 1200) + '…' : detail,
      digest: createHash('sha256').update(event.toolName + '\0' + detail).digest('hex'),
    });
    const start = performance.now();
    const { signal } = ctx;
    const decision = await ctx.ui.input('YuGo Pi computer approval', request, {
      timeout: approvalTimeoutMs,
      signal,
    });
    if (decision === 'approved' && !signal?.aborted) return;
    const reason = approvalReasons[signal?.aborted ? 'cancelled' : decision] || (
      performance.now() - start >= approvalTimeoutMs
        ? 'Approval timed out for this computer action.'
        : 'This computer action was not approved.'
    );
    return { block: true, reason: `${reason} ${deniedGuidance}` };
  });
}

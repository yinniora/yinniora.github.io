import assert from 'node:assert/strict';
import installHarness, { deduplicateToolOutput } from '../internal/rpc/harness.mjs';
import installTaskCheckpoint from '../internal/rpc/task_checkpoint.mjs';

const systemPrompt = 'Implement the requested change and verify it. Use the tools as needed.';
const toolSteps = 32;
const bash = {
  name: 'bash',
  description: 'Run a shell command in the project.',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
};

const contextHooks = [];
const toolDefinitions = new Map();
const executionGuidelines = [];
let branch = [];
const pi = {
  on(event, handler) {
    if (event === 'context_with_system') contextHooks.push(handler);
    if (event === 'before_agent_start') {
      handler({
        messageType: 'user',
        systemPromptOptions: { promptGuidelines: executionGuidelines },
      });
    }
  },
  registerTool(definition) {
    toolDefinitions.set(definition.name, definition);
  },
  appendEntry(customType, data) {
    branch.push({ type: 'custom', customType, data });
  },
  getActiveTools() {
    return [bash.name, ...toolDefinitions.keys()];
  },
};
installHarness(pi);
installTaskCheckpoint(pi);
const extraTools = [...toolDefinitions.values()].map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));
const promptGuidelines = [...toolDefinitions.values()].flatMap(
  (tool) => tool.promptGuidelines ?? [],
);
const updatedSystemPrompt = [systemPrompt, ...executionGuidelines, ...promptGuidelines].join('\n');

function extensionContext(messages) {
  return {
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => ({ messages }),
    },
  };
}

function project(messages) {
  // Pi derives provider tool definitions from the system checkpoint. Count the
  // definitions under tools in the payload instead of serializing them twice.
  let context = [
    { role: 'system', content: updatedSystemPrompt, toolsAdded: extraTools },
    ...messages,
  ];
  const ctx = extensionContext(messages);
  for (const hook of contextHooks) {
    context =
      hook({ messages: context, systemPrompt: updatedSystemPrompt }, ctx)?.messages ?? context;
  }
  return context.slice(1);
}

function buildOutput(step, failed, localized) {
  const progress = Array.from({ length: 640 }, (_, line) => {
    if (line === 320) {
      return localized ? '警告：检测到过期的配置选项' : 'warning: configuration option is obsolete';
    }
    const label = localized ? '通过 模拟套件' : 'PASS package';
    return `${label}${line % 27}/test${line} (${(line * 0.031 + step / 100).toFixed(3)}s)`;
  });
  const summary = failed
    ? ['FAIL package9/TestLease', 'worker_test.go:124: lease was not renewed', 'exit status 1']
    : ['ok fixture-build (20.621s)', 'Checks passed'];
  return ['Starting verification', ...progress, ...summary].join('\n');
}

async function runFixtureTool(id, name, args, history) {
  const output = await toolDefinitions
    .get(name)
    .execute(id, args, undefined, undefined, extensionContext(history));
  return {
    call: { type: 'toolCall', id, name, arguments: args },
    result: {
      role: 'toolResult',
      toolName: name,
      toolCallId: id,
      isError: false,
      content: output.content,
    },
  };
}

async function workflow({ verbose, localized, wide, checkpoint, retrieve }) {
  branch = [];
  const history = [{ role: 'user', content: [{ type: 'text', text: 'Repair the worker.' }] }];
  const requests = [history.slice()];
  for (let step = 1; step <= toolSteps; step++) {
    const isBuild = verbose && step % 8 === 0;
    const isWideSearch = wide && step === 8;
    const failed = isBuild && step === 16;
    const toolCallId = `call-${step}`;
    const command = isWideSearch
      ? 'rg --max-count 1 release-marker dist'
      : isBuild
        ? 'make check'
        : 'git status --short';
    const text = isWideSearch
      ? `dist/main.js:${'符号😀'.repeat(1700)}release-marker${'合并😀'.repeat(1700)}`
      : isBuild
        ? buildOutput(step, failed, localized)
        : ' M worker.go';
    const content = [
      {
        type: 'toolCall',
        id: toolCallId,
        name: 'bash',
        arguments: { command },
      },
    ];
    const results = [
      {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId,
        isError: failed,
        content: [{ type: 'text', text }],
      },
    ];
    if (checkpoint && (step === 1 || step === 17)) {
      const input =
        step === 1
          ? { goal: 'Repair the worker', tasks: [{ id: 'retry', text: 'Verify retries' }] }
          : { tasks: [{ id: 'tests', text: 'Run regression tests' }] };
      const change = await runFixtureTool(
        `checkpoint-${step}`,
        'yugo_task_checkpoint',
        input,
        history,
      );
      content.push(change.call);
      results.push(change.result);
    }

    history.push({ role: 'assistant', content }, ...results);
    requests.push(history.slice());
    if (retrieve && step === 8) {
      const omitted = await runFixtureTool(
        'read-first-build',
        'pi_web_read_shell_output',
        isWideSearch
          ? { toolCallId, startLine: 1, findText: 'release-marker' }
          : {
              toolCallId,
              startLine: 160,
              lineCount: 24,
            },
        history,
      );
      if (isWideSearch) assert.match(omitted.result.content[0].text, /release-marker/);
      history.push({ role: 'assistant', content: [omitted.call] }, omitted.result);
      requests.push(history.slice());
    }
  }
  return requests;
}

function sharedPrefixLength(previous, current) {
  const limit = Math.min(previous.length, current.length);
  let length = 0;
  while (length < limit && previous[length] === current[length]) length++;
  return length;
}

function measure(requests, projection, tools, prompt) {
  let previous = '';
  let prefixStable = true;
  let totalBytes = 0;
  let reusedBytes = 0;
  for (const request of requests) {
    const messages = projection(request);
    const payload = JSON.stringify({ systemPrompt: prompt, tools, messages });
    const prefix = sharedPrefixLength(previous, payload);
    // The previous payload closed the messages array and request object.
    prefixStable &&= prefix >= previous.length - 2;
    totalBytes += Buffer.byteLength(payload);
    reusedBytes += Buffer.byteLength(payload.slice(0, prefix));
    previous = payload;
  }
  return {
    requests: requests.length,
    totalBytes,
    reusedBytes,
    newBytes: totalBytes - reusedBytes,
    lastBytes: Buffer.byteLength(previous),
    prefixStable,
  };
}

const percentSaved = (baseline, updated) => `${((1 - updated / baseline) * 100).toFixed(1)}%`;
const rows = [];
function record(workflow, revision, result, baseline) {
  rows.push({
    workflow,
    revision,
    requests: result.requests,
    'cumulative input bytes': result.totalBytes,
    'stable prefix bytes': result.reusedBytes,
    'new bytes with perfect reuse': result.newBytes,
    'final input bytes': result.lastBytes,
    'cumulative bytes saved': percentSaved(baseline.totalBytes, result.totalBytes),
    'new bytes saved': percentSaved(baseline.newBytes, result.newBytes),
  });
}

for (const [name, options] of [
  ['sparse', {}],
  ['verbose', { verbose: true }],
  ['verbose CJK', { verbose: true, localized: true }],
  ['wide CJK search result', { wide: true }],
]) {
  const requests = await workflow(options);
  const original = measure(
    requests,
    (messages) => deduplicateToolOutput(messages) ?? messages,
    [bash],
    systemPrompt,
  );
  const snapshot = JSON.stringify(requests.at(-1));
  const updated = measure(requests, project, [bash, ...extraTools], updatedSystemPrompt);
  assert.equal(JSON.stringify(requests.at(-1)), snapshot, 'Source transcript must remain intact');
  assert.equal(updated.prefixStable, true, 'Appending a tool result must preserve the prefix');
  if (options.verbose || options.wide) {
    assert(updated.totalBytes < original.totalBytes, 'Projection must reduce a long log workload');
  } else {
    assert.equal(
      JSON.stringify(project(requests.at(-1))),
      snapshot,
      'Sparse output must remain unchanged',
    );
  }
  record(name, 'baseline', original, original);
  record(name, 'projected', updated, original);
  if (name === 'verbose') {
    const withCheckpoint = await workflow({ ...options, checkpoint: true, retrieve: true });
    const measured = measure(withCheckpoint, project, [bash, ...extraTools], updatedSystemPrompt);
    assert.equal(
      measured.prefixStable,
      true,
      'Tool reads and checkpoint updates preserve prior prefixes',
    );
    record(name, 'two checkpoint updates + one retrieval', measured, original);
  }
  if (options.wide) {
    const withLookup = await workflow({ ...options, retrieve: true });
    const measured = measure(withLookup, project, [bash, ...extraTools], updatedSystemPrompt);
    assert.equal(measured.prefixStable, true, 'Looking up omitted text must preserve the prefix');
    assert(measured.totalBytes < original.totalBytes, 'A targeted lookup must still save input');
    record(name, 'one exact lookup', measured, original);
  }
}
console.table(rows);

branch = [];
const plan = {
  goal: 'Restore remote chat',
  verification: 'Reconnect after a network loss and deliver the queued message once',
  tasks: [
    ...['routing', 'auth', 'stream', 'client'].map((id) => ({
      id,
      text: `Verify the ${id} path against its expected behavior`,
      state: 'done',
      note: `The ${id} integration check passed with a local fixture; evidence in ${id}.test.js`,
    })),
    { id: 'verify', text: 'Run the end-to-end reconnection check' },
  ],
};
await runFixtureTool('save-plan', 'yugo_task_checkpoint', plan, []);
const fullPlan = await runFixtureTool('read-plan', 'yugo_task_checkpoint', {}, []);
const timestamp = new Date(0).toISOString();
branch.push(
  { type: 'message', id: 'kept' },
  { type: 'compaction', firstKeptEntryId: 'kept', timestamp },
);
const summary = { role: 'compactionSummary', timestamp: 0, summary: 'Fixture summary' };
const [projected] = project([summary]);
const legacyHandoff = [
  summary.summary,
  '',
  'Task checkpoint at compaction. It includes all earlier checkpoint updates. Treat retained earlier messages as reference. Apply later changes and user instructions.',
  ...fullPlan.result.content[0].text.split('\n').filter((line) => !line.startsWith('Verify: ')),
].join('\n');
assert.match(projected.summary, /Verify: Reconnect after a network loss/);
assert.match(projected.summary, /routing \[done\]/);
assert.match(fullPlan.result.content[0].text, /routing\.test\.js/);
assert(Buffer.byteLength(projected.summary) < Buffer.byteLength(legacyHandoff));
console.log(
  `Compacted plan fixture with four closed items: ${Buffer.byteLength(legacyHandoff)} → ${Buffer.byteLength(projected.summary)} bytes. Full evidence remains available.`,
);
console.log(
  'Local synthetic requests only. Schemas and checkpoint guidance are included. The simulated retrieval adds a model step. Bytes are an input-size proxy. Perfect reuse is a lower bound on new input, and is not a cache prediction. Provider token counts, cache rules and per-request charges determine billing.',
);

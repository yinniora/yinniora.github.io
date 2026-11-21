import { describe, expect, it } from 'vitest';
import installHarness, { deduplicateToolOutput } from '../../internal/rpc/harness.mjs';

const output = 'same sample code line\n'.repeat(1024);
const readResult = (id: string) => ({
  role: 'toolResult',
  toolName: 'read',
  toolCallId: id,
  content: [{ type: 'text', text: output }],
});
const shellReader = 'pi_web_read_shell_output';
const shellResult = (id: string, text: string) => ({
  ...readResult(id),
  toolName: 'bash',
  content: [{ type: 'text', text }],
});
const logLines = Array.from(
  { length: 160 },
  (_, index) =>
    `Progress line ${index + 1} built workspace dependency package-${index + 1} successfully`,
);
logLines[78] = 'suite 79 contains the failing check';
logLines[79] = 'src/lib.ts:55:6: error TS2322: invalid assignment';
logLines[80] = 'the number cannot be assigned to string';
logLines[94] = '警告：配置已弃用';

function shellHarness(original: unknown[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  installHarness({
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
  });
  const ctx = { sessionManager: { buildSessionProjection: () => ({ messages: original }) } };
  return {
    handlers,
    project: (messages: unknown[]) => handlers.get('context_with_system')!({ messages }, ctx),
    read: (params: object) =>
      tools.get(shellReader).execute('read-id', params, undefined, undefined, ctx),
  };
}

describe('YuGo harness model context', () => {
  it('deduplicates a large result without mutating the transcript or the existing prefix', () => {
    const system = { role: 'system', content: 'System instructions and tools' };
    const first = readResult('first');
    const repeat = readResult('repeat');
    const prefix = [system, first, repeat];
    expect(deduplicateToolOutput([system, first])).toBeUndefined();

    const projected = deduplicateToolOutput(prefix)!;
    expect(projected[0]).toBe(system);
    expect(projected[1]).toBe(first);
    expect(projected[2]).toMatchObject({ toolCallId: 'repeat' });
    expect(projected[2].content[0].text).toContain('first');
    expect(projected[2].content[0].text.length).toBeLessThan(output.length / 50);
    expect(repeat.content[0].text).toBe(output);
    expect(deduplicateToolOutput([...prefix, readResult('next')])!.slice(0, prefix.length)).toEqual(
      projected,
    );
  });

  it('preserves partial, structured, image, error, and side-effecting results', () => {
    const first = readResult('first');
    const altered = [
      { ...readResult('different'), content: [{ type: 'text', text: output + 'diff' }] },
      { ...readResult('error'), isError: true },
      { ...readResult('structured'), structuredContent: {} },
      { ...readResult('bash'), toolName: 'bash' },
      { ...readResult('image'), content: [{ type: 'image', data: 'sample' }] },
      { ...readResult('mixed'), content: [...first.content, { type: 'text', text: 'next' }] },
    ];
    expect(deduplicateToolOutput([first, ...altered])).toBeUndefined();
  });

  it('uses native warming for direct providers and omits artificial refresh requests for YuGo keys', () => {
    const { handlers } = shellHarness([]);
    expect(
      handlers.get('cache_warming_decision')!({}, { model: { provider: 'anthropic' } }),
    ).toBeUndefined();
    expect(
      handlers.get('cache_warming_decision')!({}, { model: { provider: 'yugo-custom' } }),
    ).toEqual({ action: 'stop' });

    const event = { systemPromptOptions: { promptGuidelines: ['existing guideline'] } };
    handlers.get('before_agent_start')!(event);
    handlers.get('before_agent_start')!(event);
    expect(event.systemPromptOptions.promptGuidelines).toHaveLength(2);
    expect(event.systemPromptOptions.promptGuidelines[1]).toContain('Batch independent reads');
  });

  it('keeps build diagnostics and stable, recoverable line numbers in less than half the bytes', async () => {
    const system = { role: 'system', toolsAdded: [{ name: shellReader }] };
    const text = logLines.join('\n');
    const bash = shellResult('tool-42', text);
    const { project, read } = shellHarness([bash]);
    const messages = [system, bash];
    const projected = project(messages).messages;
    const excerpt = projected[1].content[0].text;
    expect(projected[0]).toBe(system);
    expect(excerpt).toContain('toolCallId "tool-42"');
    expect(excerpt).toContain(`79 | ${logLines[78]}`);
    expect(excerpt).toContain(`80 | ${logLines[79]}`);
    expect(excerpt).toContain(`81 | ${logLines[80]}`);
    expect(excerpt).toContain(`95 | ${logLines[94]}`);
    expect(excerpt).toContain(`160 | ${logLines[159]}`);
    expect(excerpt).not.toContain(logLines[52]);
    expect(Buffer.byteLength(excerpt)).toBeLessThan(Buffer.byteLength(text) / 2);
    expect(bash.content[0].text).toBe(text);
    const regularBuild = logLines.slice(0, 50).join('\n');
    const following = project([...messages, shellResult('next', regularBuild)]).messages;
    expect(following.slice(0, 2)).toEqual(projected);
    expect(Buffer.byteLength(regularBuild)).toBeGreaterThanOrEqual(3072);
    expect(Buffer.byteLength(regularBuild)).toBeLessThan(4096);
    expect(Buffer.byteLength(following[2].content[0].text)).toBeLessThan(regularBuild.length * 0.7);

    const recovered = await read({ toolCallId: 'tool-42', startLine: 53, lineCount: 2 });
    expect(recovered.content[0].text).toBe(
      `Bash output lines 53–54 of 160.\n53 | ${logLines[52]}\n54 | ${logLines[53]}`,
    );
    await expect(read({ toolCallId: 'other-branch', startLine: 53 })).rejects.toThrow(
      'active model context',
    );
  });

  it('bounds wide lines and restores their exact Unicode code-point columns in chunks', async () => {
    const system = { role: 'system', toolsAdded: [{ name: shellReader }] };
    const findText = '🔑隐藏匹配[abc].';
    const longLine = `Beginning ${'🧪中'.repeat(1800)} ${findText} ${'🐦'.repeat(100)} warning nearby ${'🚲'.repeat(1800)} end`;
    const original = `Command matches:\n${longLine}\nNext ${findText}`;
    const bash = shellResult('wide', original);
    const { project, read } = shellHarness([bash]);
    const projected = project([system, bash]).messages;
    const excerpt = projected[1].content[0].text;
    expect(excerpt).toContain('omitted lines or columns');
    expect(excerpt).toContain('2 | [1–128] Beginning');
    expect(excerpt).toContain('warning nearby');
    expect(excerpt).toContain(' end');
    expect(excerpt.split('\n').find((line: string) => line.startsWith('2 | '))).not.toContain(
      findText,
    );
    expect(Buffer.byteLength(excerpt)).toBeLessThan(Buffer.byteLength(original) / 8);
    expect(bash.content[0].text).toBe(original);
    expect(project([system, bash, shellResult('next', 'ok')]).messages.slice(0, 2)).toEqual(
      projected,
    );

    const characters = Array.from(longLine);
    const beforeMatch = longLine.slice(0, longLine.indexOf(findText));
    const matchColumn = Array.from(beforeMatch).length + 1;
    const readMatch = await read({ toolCallId: 'wide', startLine: 2, startColumn: matchColumn });
    expect(readMatch.content[0].text.split('\n')[1]).toMatch(/^2 \| 🔑隐藏匹配\[abc\]\./);
    const firstMatch = await read({ toolCallId: 'wide', startLine: 1, findText });
    expect(firstMatch.content[0].text).toContain(`match at line 2, column ${matchColumn} `);
    expect(firstMatch.content[0].text).toContain(findText);
    expect(Buffer.byteLength(firstMatch.content[0].text)).toBeLessThan(512);
    const nextMatch = await read({
      toolCallId: 'wide',
      startLine: 2,
      startColumn: matchColumn + 1,
      findText,
    });
    expect(nextMatch.content[0].text).toContain('match at line 3, column 6');
    const noMatch = await read({ toolCallId: 'wide', startLine: 1, findText: '隐藏匹配abc' });
    expect(noMatch.content[0].text).toContain('No exact match');
    await expect(read({ toolCallId: 'other-branch', startLine: 1, findText })).rejects.toThrow(
      'active model context',
    );

    const restored = [];
    let startColumn: number | undefined;
    do {
      const chunk = await read({ toolCallId: 'wide', startLine: 2, startColumn });
      const result = chunk.content[0].text;
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8192);
      restored.push(result.split('\n')[1].slice('2 | '.length));
      const next = result.match(/Continue with startColumn (\d+)/);
      startColumn = next ? Number(next[1]) : undefined;
    } while (startColumn);
    expect(restored.length).toBeGreaterThan(1);
    expect(restored.join('')).toBe(longLine);
    await expect(
      read({ toolCallId: 'wide', startLine: 2, startColumn: characters.length + 1 }),
    ).rejects.toThrow('Choose a column');
  });

  it('leaves errors, machine-readable data and results without accessible recovery intact', () => {
    const system = { role: 'system', toolsAdded: [{ name: shellReader }] };
    const removed = { role: 'system', toolsRemoved: [{ name: shellReader }] };
    const bash = shellResult('tool-42', logLines.join('\n'));
    const { project } = shellHarness([bash]);
    expect(project([bash])).toBeUndefined();
    expect(project([system, bash, removed])).toBeUndefined();
    expect(
      project([
        system,
        { ...bash, isError: true },
        { ...bash, structuredContent: { result: 'keep this' } },
        { ...bash, content: [...bash.content, { type: 'image', data: 'image' }] },
        shellResult('json', JSON.stringify(logLines, null, 2)),
        shellResult('json-wide', JSON.stringify({ result: 'A'.repeat(10000) })),
        shellResult('json-lines-wide', `${JSON.stringify({ result: 'A'.repeat(10000) })}\n{}`),
        shellResult('escape-wide', `\x1b[31m${'A'.repeat(10000)}`),
        shellResult('too-many-errors', logLines.map((line) => `ERROR: ${line}`).join('\n')),
      ]),
    ).toBeUndefined();
  });
});

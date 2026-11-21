import { describe, expect, it } from 'vitest';
import installHarness, { deduplicateToolOutput } from '../../internal/rpc/harness.mjs';

const output = 'same sample code line\n'.repeat(1024);
const readResult = (id: string) => ({
  role: 'toolResult',
  toolName: 'read',
  toolCallId: id,
  content: [{ type: 'text', text: output }],
});

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
    const handlers = new Map<string, (...args: any[]) => unknown>();
    installHarness({
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    });
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
  });
});

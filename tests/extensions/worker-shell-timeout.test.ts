import { describe, expect, it } from 'vitest';
import registerWorkerExtension from '../../internal/rpc/computer_guard.mjs';

describe('RPC worker shell timeout', () => {
  it.each([
    ['bash', undefined, 300],
    ['powershell', undefined, 300],
    ['bash', 2, 2],
    ['bash', 1200, 1200],
    ['read', undefined, undefined],
  ])('handles %s timeout %s', async (toolName, timeout, expected) => {
    const toolCallHandlers = [];
    registerWorkerExtension({
      registerCommand: () => {},
      on: (name, handler) => {
        if (name === 'tool_call') toolCallHandlers.push(handler);
      },
    });
    const event = { toolName, input: timeout === undefined ? {} : { timeout } };
    for (const handle of toolCallHandlers) await handle(event, {});
    expect(event.input.timeout).toBe(expected);
  });
});

describe('RPC worker Anthropic authentication', () => {
  it.each([
    ['anthropic-messages', undefined, null],
    ['anthropic-messages', 'fixture-key', null],
    ['anthropic-messages', 'another-fixture', 'another-fixture'],
    ['openai-completions', 'fixture-key', 'fixture-key'],
  ])('keeps the applicable key header for %s and %s', (api, key, expected) => {
    let beforeHeaders;
    registerWorkerExtension({
      registerCommand: () => {},
      on: (event, handler) => {
        if (event === 'before_provider_headers') beforeHeaders = handler;
      },
    });
    const headers = { Authorization: 'Bearer fixture-key', 'x-api-key': key };
    beforeHeaders({ headers }, { model: { api } });
    expect(headers['x-api-key']).toBe(expected);
    expect(headers.Authorization).toBe('Bearer fixture-key');
  });
});

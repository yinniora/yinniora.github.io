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

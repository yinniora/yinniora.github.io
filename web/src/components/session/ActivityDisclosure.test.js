import { afterEach, expect, it } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SessionEntry from './SessionEntry.svelte';
import ToolCall from './ToolCall.svelte';
import { createToggleController } from '../../session/ui/toggle-state.js';
import { sessionRuntime, resetSessionRuntime } from '../../session/session-runtime.js';
afterEach(() => {
  cleanup();
  resetSessionRuntime();
  localStorage.clear();
});
it('individually toggles and remembers thinking and tool disclosures across render passes', async () => {
  const controller = createToggleController({
    sessionId: 'demo',
    initialState: { thinkingExpanded: false, toolsVisible: false, toolOutputsExpanded: false },
  });
  sessionRuntime.toggleState = controller;
  const entry = {
    id: 'e',
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Brief model reasoning summary.' }],
    },
  };
  const first = render(SessionEntry, { props: { entry, live: true } });
  controller.applyToNode(document);
  let details = first.container.querySelector('details');
  expect(details.open).toBe(false);
  await fireEvent.click(details.querySelector('summary'));
  expect(details.open).toBe(true);
  controller.applyToNode(document);
  expect(details.open).toBe(true);
  const reloaded = createToggleController({
    sessionId: 'demo',
    initialState: { thinkingExpanded: false, toolsVisible: false, toolOutputsExpanded: false },
  });
  reloaded.applyToNode(document);
  expect(details.open).toBe(true);
  render(ToolCall, {
    props: {
      call: { id: 'call', name: 'bash', arguments: { command: 'echo hello' } },
      model: { entries: [] },
      live: true,
    },
  });
  controller.setAllExpanded(true);
  expect([...document.querySelectorAll('details')].every((el) => el.open)).toBe(true);
  controller.setAllExpanded(false);
  expect([...document.querySelectorAll('details')].some((el) => el.open)).toBe(false);
});
it('keeps a pending user question open by default', () => {
  const { container } = render(ToolCall, {
    props: {
      call: { id: 'question', name: 'ask_question', arguments: { question: 'Choose' } },
      model: { entries: [] },
      live: true,
    },
  });
  createToggleController({
    initialState: { thinkingExpanded: false, toolsVisible: false, toolOutputsExpanded: false },
  }).applyToNode(container);
  expect(container.querySelector('details').open).toBe(true);
});

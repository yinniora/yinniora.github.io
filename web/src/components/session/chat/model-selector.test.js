import { afterEach, expect, it, vi } from 'vitest';
import { setupModelSelector } from './model-selector.js';
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('lets mobile users open the model panel without a keyboard and dismiss search after selection', async () => {
  document.body.innerHTML =
    '<button id="pi-chat-model-label">Model</button><div id="pi-chat-model-popup" style="display:none"><input id="pi-chat-model-search"><div id="pi-chat-model-list"></div></div><textarea id="pi-chat-message"></textarea>';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  const chatApi = {
    listModels: vi.fn(
      async () =>
        new Response(
          JSON.stringify({ models: [{ provider: 'demo', id: 'model', name: 'Demo model' }] }),
        ),
    ),
    setModel: vi.fn(async () => new Response('{}')),
  };
  const api = setupModelSelector({ documentImpl: document, sessionId: 's.jsonl', chatApi });
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.open();
  const search = document.getElementById('pi-chat-model-search');
  expect(document.activeElement).not.toBe(search);
  search.focus();
  expect(document.activeElement).toBe(search);
  document.querySelector('.model-item').click();
  expect(document.getElementById('pi-chat-model-popup').style.display).toBe('none');
  expect(document.activeElement).not.toBe(search);
  expect(document.activeElement).not.toBe(document.getElementById('pi-chat-message'));
});

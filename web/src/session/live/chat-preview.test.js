import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  clearChatPreviewState as clearChatPreview,
  finishChatPreviewState as finishChatPreview,
  renderChatPreviewState as renderChatPreview,
  renderPendingChatState as renderPendingChat,
  formatToolDuration,
  updateToolDuration,
} from './chat-preview.js';

describe('chat preview', () => {
  it('shows which model request is being retried without implying the phone disconnected', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    const state = { chatPreviewEl: null, pendingUserEl: null };
    renderChatPreview(
      { content: '', phase: 'retrying', retryStage: 'connect', retryAttempt: 2, retryLimit: 3 },
      state,
      {
        documentImpl: dom.window.document,
        renderMarkdown: (text) => text,
        setIntervalImpl: () => 1,
      },
    );
    expect(state.chatPreviewEl.querySelector('.preview-progress .preview-text').textContent).toBe(
      'Retrying model request · Could not connect to model · 2/3',
    );
  });

  it('shows the running tool and its elapsed time on the progress line', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    let now = 1000;
    const windowImpl = { performance: { now: () => now } };
    const state = { chatPreviewEl: null, pendingUserEl: null };
    const opts = {
      documentImpl: dom.window.document,
      windowImpl,
      renderMarkdown: (text) => text,
      setIntervalImpl: () => 1,
    };
    renderChatPreview(
      { content: '', phase: 'tool', toolName: 'bash', toolElapsedMs: 61000 },
      state,
      opts,
    );
    const progress = state.chatPreviewEl.querySelector('.preview-progress');
    expect(progress.querySelector('.preview-tool').textContent).toBe('bash');
    expect(progress.querySelector('.preview-duration').textContent).toBe('1:01');
    now += 5000;
    updateToolDuration(state, windowImpl);
    expect(progress.querySelector('.preview-duration').textContent).toBe('1:06');

    renderChatPreview({ content: '', phase: 'working' }, state, opts);
    expect(progress.querySelector('.preview-tool').hidden).toBe(true);
    expect(progress.querySelector('.preview-duration').hidden).toBe(true);
    expect(formatToolDuration(0)).toBe('0:00');
  });

  it('renders, updates, follows, and clears preview', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    const state = { chatPreviewEl: null, pendingUserEl: null };
    const onLayoutChanged = vi.fn();

    expect(
      renderChatPreview({ content: 'hello', done: false }, state, {
        documentImpl: dom.window.document,
        renderMarkdown: (text) => `<p>${text}</p>`,
        onLayoutChanged,
      }),
    ).toBe(true);

    expect(dom.window.document.getElementById('chat-preview-stream')).toBeTruthy();
    expect(state.chatPreviewEl.querySelector('.message-content').innerHTML).toBe('<p>hello</p>');
    // Must include markdown-content so the streaming preview picks up the
    // same heading/hr/list/code styles as the settled assistant message.
    expect(
      state.chatPreviewEl.querySelector('.message-content').classList.contains('markdown-content'),
    ).toBe(true);
    expect(onLayoutChanged).toHaveBeenCalledTimes(1);

    renderChatPreview({ content: 'hello', done: false }, state, {
      documentImpl: dom.window.document,
      renderMarkdown: (text) => text,
      onLayoutChanged,
    });
    expect(onLayoutChanged).toHaveBeenCalledTimes(1);

    renderChatPreview({ content: 'done', done: true }, state, {
      documentImpl: dom.window.document,
      renderMarkdown: (text) => text,
    });
    expect(state.chatPreviewEl.classList.contains('done')).toBe(true);
    expect(state.chatPreviewEl.textContent.toLowerCase()).not.toContain('working');

    clearChatPreview(state);
    expect(dom.window.document.getElementById('chat-preview-stream')).toBe(null);
    expect(state.chatPreviewEl).toBe(null);
  });

  it('renders pending user message and working placeholder immediately', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    const state = { chatPreviewEl: null, pendingUserEl: null };
    const forceFollowToBottom = vi.fn();

    expect(
      renderPendingChat('hello **pi**', state, {
        documentImpl: dom.window.document,
        renderMarkdown: (text) => `<p>${text}</p>`,
        shouldFollow: () => true,
        forceFollowToBottom,
      }),
    ).toBe(true);

    expect(dom.window.document.getElementById('chat-pending-user')).toBeTruthy();
    expect(dom.window.document.getElementById('chat-pending-user').textContent).toContain(
      'hello **pi**',
    );
    expect(dom.window.document.getElementById('chat-preview-stream')).toBeTruthy();
    expect(
      dom.window.document.getElementById('chat-preview-stream').textContent.toLowerCase(),
    ).toContain('working');
    expect(forceFollowToBottom).toHaveBeenCalledWith(false);

    clearChatPreview(state);
    expect(dom.window.document.getElementById('chat-pending-user')).toBe(null);
    expect(dom.window.document.getElementById('chat-preview-stream')).toBe(null);
  });

  it('can finish a pending preview without removing assistant text', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    const state = { chatPreviewEl: null, pendingUserEl: null };

    renderChatPreview({ content: 'final answer', done: false }, state, {
      documentImpl: dom.window.document,
      renderMarkdown: (text) => text,
    });

    expect(finishChatPreview(state)).toBe(true);
    expect(dom.window.document.getElementById('chat-preview-stream').textContent).toContain(
      'final answer',
    );
    expect(
      dom.window.document.getElementById('chat-preview-stream').textContent.toLowerCase(),
    ).not.toContain('working');
    expect(state.chatPreviewEl.classList.contains('done')).toBe(true);
  });

  it('clears pending user but keeps assistant preview when keepAssistant option is true', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    const state = { chatPreviewEl: null, pendingUserEl: null };

    renderPendingChat('hello pi', state, {
      documentImpl: dom.window.document,
      renderMarkdown: (text) => text,
    });

    expect(dom.window.document.getElementById('chat-pending-user')).toBeTruthy();
    expect(dom.window.document.getElementById('chat-preview-stream')).toBeTruthy();

    clearChatPreview(state, { keepAssistant: true });
    // pending user element should be removed from the DOM and cleared
    expect(dom.window.document.getElementById('chat-pending-user')).toBeNull();
    expect(state.pendingUserEl).toBeNull();
    // assistant preview should still be in the DOM and NOT cleared
    expect(dom.window.document.getElementById('chat-preview-stream')).toBeTruthy();
    expect(state.chatPreviewEl).toBeTruthy();

    // And clearing it without keepAssistant removes it
    clearChatPreview(state, { keepAssistant: false });
    expect(dom.window.document.getElementById('chat-preview-stream')).toBeNull();
    expect(state.chatPreviewEl).toBeNull();
  });

  it('coalesces streamed markdown to a fixed cadence while keeping the final render', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    let now = 1000;
    const windowImpl = { performance: { now: () => now } };
    const state = { chatPreviewEl: null, pendingUserEl: null, thinking: '' };
    let renders = 0;
    const opts = {
      documentImpl: dom.window.document,
      windowImpl,
      renderMarkdown: (text) => {
        renders += 1;
        return text;
      },
      setIntervalImpl: () => 1,
      markdownIntervalMs: 120,
    };

    renderChatPreview({ content: 'one', phase: 'working' }, state, opts);
    const afterFirst = renders;

    // Same frame burst: the progress line updates, the markdown does not.
    now += 30;
    renderChatPreview({ content: 'one two', phase: 'working' }, state, opts);
    expect(renders).toBe(afterFirst);
    expect(state.chatPreviewEl.querySelector('.preview-text').textContent).toBe('Thinking');

    // Past the cadence the accumulated text paints once.
    now += 120;
    renderChatPreview({ content: 'one two three', phase: 'working' }, state, opts);
    expect(renders).toBe(afterFirst + 1);

    // A finished turn paints the final text regardless of the cadence.
    renderChatPreview({ content: 'one two three four', phase: 'working', done: true }, state, opts);
    expect(renders).toBe(afterFirst + 2);
    expect(state.chatPreviewEl.querySelector('.message-content').textContent).toContain(
      'one two three four',
    );
  });

  it('streams thinking as plain text and never re-creates the block', () => {
    const dom = new JSDOM('<body><div id="messages"></div></body>');
    let now = 1000;
    const windowImpl = { performance: { now: () => now } };
    const state = { chatPreviewEl: null, pendingUserEl: null };
    let renders = 0;
    const opts = {
      documentImpl: dom.window.document,
      windowImpl,
      renderMarkdown: (text) => {
        renders += 1;
        return text;
      },
      setIntervalImpl: () => 1,
      markdownIntervalMs: 120,
    };

    renderChatPreview(
      { content: 'answer', thinking: 'look at <the> file', phase: 'thinking' },
      state,
      opts,
    );
    const block = state.chatPreviewEl.querySelector('.preview-thinking');
    expect(block.hidden).toBe(false);
    expect(block.open).toBe(true);
    const body = block.querySelector('.preview-thinking-text');
    expect(body.textContent).toBe('look at <the> file');
    expect(body.querySelector('the')).toBeNull();

    const rendersAfterFirst = renders;
    now += 20;
    renderChatPreview(
      { content: 'answer', thinking: 'look at <the> file and', phase: 'thinking' },
      state,
      opts,
    );
    // Throttled: neither the reply nor the thinking re-renders within the cadence.
    expect(body.textContent).toBe('look at <the> file');
    expect(renders).toBe(rendersAfterFirst);
    expect(state.chatPreviewEl.querySelector('.preview-thinking')).toBe(block);

    now += 200;
    renderChatPreview(
      { content: 'answer', thinking: 'look at <the> file and', phase: 'thinking' },
      state,
      opts,
    );
    expect(body.textContent).toBe('look at <the> file and');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setupChatSubmission } from './chat-submit.js';

function setupDom() {
  const dom = new JSDOM(
    '<body><form id="form"><textarea id="message"></textarea><button id="send" type="submit"></button><button id="cancel" type="button"></button></form></body>',
    { url: 'http://localhost/session?id=s1' },
  );
  return {
    dom,
    form: dom.window.document.getElementById('form'),
    textarea: dom.window.document.getElementById('message'),
    sendButton: dom.window.document.getElementById('send'),
    cancelButton: dom.window.document.getElementById('cancel'),
  };
}

function createAttachments({ files = [], textAttachments = [], message = '' } = {}) {
  return {
    files: vi.fn(() => files),
    textAttachments: vi.fn(() => textAttachments),
    composeMessage: vi.fn(() => message),
    clear: vi.fn(),
    restore: vi.fn(),
  };
}

describe('chat submit', () => {
  it('sends a composed message and dispatches the live preview event', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    textarea.value = ' hello ';
    const attachments = createAttachments({ message: 'hello' });
    const sendChat = vi.fn(() =>
      Promise.resolve(new Response('{"status":"queued"}', { status: 200 })),
    );
    const setStatus = vi.fn();
    const updateSendEnabled = vi.fn();
    const dispatched = [];
    dom.window.addEventListener('pi-chat-message-sent', (event) =>
      dispatched.push(event.detail.message),
    );

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: { sendChat, cancelChat: vi.fn() },
      sessionId: 's1',
      setStatus,
      autoResizeTextarea: vi.fn(),
      updateSendEnabled,
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
    });

    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendChat).toHaveBeenCalledWith(
      's1',
      expect.any(dom.window.FormData),
      expect.objectContaining({
        requestId: expect.any(String),
      }),
    );
    expect(sendChat.mock.calls[0][1].get('message')).toBe('hello');
    expect(dispatched).toEqual(['hello']);
    expect(attachments.clear).toHaveBeenCalled();
    expect(attachments.restore).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('queued', 'running');
    expect(sendButton.disabled).toBe(false);
    expect(updateSendEnabled).toHaveBeenCalled();
  });

  it('restores the draft and attachments when send fails', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    textarea.value = ' retry ';
    const file = new dom.window.File(['img'], 'a.png', { type: 'image/png' });
    const textAttachment = { original: 'quote', note: '' };
    const attachments = createAttachments({
      files: [file],
      textAttachments: [textAttachment],
      message: 'retry',
    });
    const autoResizeTextarea = vi.fn();

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: {
        sendChat: vi.fn(() => Promise.resolve(new Response('{"error":"boom"}', { status: 500 }))),
        cancelChat: vi.fn(),
      },
      sessionId: 's1',
      setStatus: vi.fn(),
      autoResizeTextarea,
      updateSendEnabled: vi.fn(),
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
    });

    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(textarea.value).toBe('retry');
    expect(attachments.restore).toHaveBeenCalledWith({
      files: [file],
      textAttachments: [textAttachment],
    });
    expect(autoResizeTextarea).toHaveBeenCalled();
  });

  it('rejects an empty draft without sending', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    const attachments = createAttachments({ message: '' });
    const sendChat = vi.fn();
    const setStatus = vi.fn();

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: { sendChat, cancelChat: vi.fn() },
      setStatus,
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
    });

    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendChat).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('message or image required', 'error');
  });

  it('cancels the worker and refreshes worker status', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    const cancelChat = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const setStatus = vi.fn();
    const refresh = vi.fn();

    const submission = setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments: createAttachments(),
      chatApi: { sendChat: vi.fn(), cancelChat },
      sessionId: 's1',
      setStatus,
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
    });
    submission.setRefreshWorkerStatus(refresh);

    cancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelChat).toHaveBeenCalledWith('s1');
    expect(setStatus).toHaveBeenCalledWith('cancelling', 'running');
    expect(setStatus).toHaveBeenCalledWith('idle', '');
    expect(refresh).toHaveBeenCalled();
    expect(cancelButton.disabled).toBe(false);
  });
});

describe('chat submit retries a phone that lost its link', () => {
  it('keeps the draft in flight until the connection comes back', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    textarea.value = 'hello';
    const attachments = createAttachments({ message: 'hello' });
    const sendChat = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockRejectedValueOnce(
        new TypeError(
          'Connection error.: Client network socket disconnected before secure TLS connection was established (ECONNRESET)',
        ),
      )
      .mockResolvedValue(new Response('{"status":"queued"}', { status: 202 }));
    const setStatus = vi.fn();
    const sleepImpl = vi.fn(() => Promise.resolve());

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: { sendChat },
      sessionId: 's1',
      setStatus,
      autoResizeTextarea: vi.fn(),
      updateSendEnabled: vi.fn(),
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
      sleepImpl,
    });

    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(sendChat).toHaveBeenCalledTimes(3));
    expect(new Set(sendChat.mock.calls.map((call) => call[2].requestId)).size).toBe(1);

    expect(setStatus).toHaveBeenCalledWith('reconnecting', 'running');
    expect(setStatus).toHaveBeenLastCalledWith('queued', 'running');
    expect(attachments.restore).not.toHaveBeenCalled();
  });

  it('gives up and hands the draft back after the grace window', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    textarea.value = 'hello';
    const attachments = createAttachments({ message: 'hello' });
    const sendChat = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    const setStatus = vi.fn();
    const sleepImpl = vi.fn(() => Promise.resolve());
    const failed = vi.fn();
    dom.window.addEventListener('pi-chat-message-failed', failed);

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: { sendChat },
      sessionId: 's1',
      setStatus,
      autoResizeTextarea: vi.fn(),
      updateSendEnabled: vi.fn(),
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
      sleepImpl,
      retryDeadlineMs: 3000,
    });

    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());

    expect(setStatus).toHaveBeenLastCalledWith('Load failed', 'error');
    expect(attachments.restore).toHaveBeenCalled();
    expect(sendChat.mock.calls.length).toBeLessThan(10);
  });

  it('fails at once on a rejected request instead of retrying it', async () => {
    const { dom, form, textarea, sendButton, cancelButton } = setupDom();
    textarea.value = 'hello';
    const attachments = createAttachments({ message: 'hello' });
    const sendChat = vi.fn(() =>
      Promise.resolve(new Response('{"error":"session is busy"}', { status: 409 })),
    );

    setupChatSubmission({
      windowImpl: dom.window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: { sendChat },
      sessionId: 's1',
      setStatus: vi.fn(),
      autoResizeTextarea: vi.fn(),
      updateSendEnabled: vi.fn(),
      FormDataImpl: dom.window.FormData,
      CustomEventImpl: dom.window.CustomEvent,
      sleepImpl: vi.fn(() => Promise.resolve()),
    });

    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(attachments.restore).toHaveBeenCalled());
    expect(sendChat).toHaveBeenCalledTimes(1);
  });
});

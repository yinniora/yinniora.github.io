import { describe, expect, it, vi } from 'vitest';
import { setupWorkerStatusPolling } from './worker-status.js';

const response = (data) => ({
  ok: true,
  json: () => Promise.resolve(data),
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('setupWorkerStatusPolling', () => {
  it('updates status, labels, context usage, and model selector state', async () => {
    let knownModelLabel = '';
    let knownThinkingLevel = '';
    const setStatus = vi.fn();
    const setModelLabel = vi.fn();
    const setThinkingLabel = vi.fn();
    const updateContextUsage = vi.fn();
    const onWorkerModelUpdate = vi.fn();

    setupWorkerStatusPolling({
      windowImpl: new EventTarget(),
      sessionId: 's',
      chatApi: {
        getWorkerStatus: vi.fn(() =>
          Promise.resolve(
            response({
              state: 'running',
              model: 'gpt-4o',
              modelProvider: 'openai',
              thinkingLevel: 'high',
            }),
          ),
        ),
      },
      setStatus,
      setModelLabel,
      setThinkingLabel,
      updateContextUsage,
      getKnownModelLabel: () => knownModelLabel,
      setKnownModelLabel: (label) => {
        knownModelLabel = label;
      },
      getKnownThinkingLevel: () => knownThinkingLevel,
      setKnownThinkingLevel: (level) => {
        knownThinkingLevel = level;
      },
      getWorkerModelUpdate: () => onWorkerModelUpdate,
      setIntervalImpl: () => {},
      CustomEventImpl: Event,
    });
    await tick();

    expect(setStatus).toHaveBeenCalledWith('running', 'running');
    expect(setModelLabel).toHaveBeenCalledWith('gpt-4o @ openai');
    expect(setThinkingLabel).toHaveBeenCalledWith('high');
    expect(updateContextUsage).toHaveBeenCalled();
    expect(onWorkerModelUpdate).toHaveBeenCalledWith('openai', 'gpt-4o', undefined);
  });

  it('dispatches pi-worker-done on running to idle transition', async () => {
    const events = [];
    const windowImpl = new EventTarget();
    windowImpl.addEventListener('pi-worker-done', (event) => events.push(event.type));
    const getWorkerStatus = vi
      .fn()
      .mockResolvedValueOnce(response({ state: 'running' }))
      .mockResolvedValueOnce(response({ state: 'idle' }));

    const controller = setupWorkerStatusPolling({
      windowImpl,
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => {},
      CustomEventImpl: Event,
    });
    await tick();
    await controller.refresh();

    expect(events).toEqual(['pi-worker-done']);
  });

  it('reports a handled request once when delivery finishes without ending the active run', async () => {
    const windowImpl = new EventTarget();
    const completed = vi.fn();
    const handled = vi.fn();
    windowImpl.addEventListener('pi-worker-done', completed);
    windowImpl.addEventListener('pi-chat-prompt-handled', handled);
    let delivering = true;
    const controller = setupWorkerStatusPolling({
      windowImpl,
      sessionId: 'session',
      chatApi: {
        getWorkerStatus: async () => response({ state: 'running', handledPrompt: 'request-id' }),
      },
      deliveryPending: () => delivering,
      setIntervalImpl: () => {},
      CustomEventImpl: CustomEvent,
    });
    await tick();
    expect(handled).not.toHaveBeenCalled();

    delivering = false;
    await controller.refresh();
    await controller.refresh();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled.mock.calls[0][0].detail).toEqual({
      sessionId: 'session',
      requestId: 'request-id',
    });
    expect(completed).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('stops polling and ignores a late completion after leaving the session', async () => {
    const windowImpl = new EventTarget();
    const done = vi.fn();
    windowImpl.addEventListener('pi-worker-done', done);
    let complete;
    const getWorkerStatus = vi
      .fn()
      .mockResolvedValueOnce(response({ state: 'running' }))
      .mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
    const clearIntervalImpl = vi.fn();
    const controller = setupWorkerStatusPolling({
      windowImpl,
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => 7,
      clearIntervalImpl,
      CustomEventImpl: Event,
    });
    await tick();
    const refresh = controller.refresh();
    controller.dispose();
    expect(getWorkerStatus.mock.calls[1][1].signal.aborted).toBe(true);
    complete(response({ state: 'idle' }));
    await refresh;
    windowImpl.dispatchEvent(new Event('pi-session-reload'));
    expect(done).not.toHaveBeenCalled();
    expect(clearIntervalImpl).toHaveBeenCalledWith(7);
    expect(getWorkerStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes immediately on session reload', async () => {
    const windowImpl = new EventTarget();
    const getWorkerStatus = vi.fn(() => Promise.resolve(response({ state: 'idle' })));

    setupWorkerStatusPolling({
      windowImpl,
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => {},
      CustomEventImpl: Event,
    });
    await tick();
    const initialCalls = getWorkerStatus.mock.calls.length;

    windowImpl.dispatchEvent(new Event('pi-session-reload'));
    await tick();

    expect(getWorkerStatus.mock.calls.length).toBe(initialCalls + 1);
  });

  it('coalesces refreshes while a request is in flight', async () => {
    let resolveFirst;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const getWorkerStatus = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(response({ state: 'idle' }));

    const controller = setupWorkerStatusPolling({
      windowImpl: new EventTarget(),
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => {},
      CustomEventImpl: Event,
    });

    void controller.refresh();
    void controller.refresh();
    expect(getWorkerStatus).toHaveBeenCalledTimes(1);

    resolveFirst(response({ state: 'running' }));
    await tick();
    await tick();
    expect(getWorkerStatus).toHaveBeenCalledTimes(2);
  });
});

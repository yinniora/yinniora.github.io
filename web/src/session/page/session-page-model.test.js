import { describe, expect, it, vi } from 'vitest';
import { createLiveSessionRuntime, hydrateSessionModel } from './session-page-model.js';
import { resetSessionRuntimeContext } from '../session-runtime-context.js';

describe('session page model helpers', () => {
  it('hydrates the reactive model from the object payload and creates runtime hooks', () => {
    const payload = {
      header: { cwd: '/tmp/project' },
      entries: [{ id: 'root' }, { id: 'leaf' }],
      leafId: 'leaf',
    };
    const sessionModel = {
      load: vi.fn(function load(data) {
        Object.assign(this, data);
      }),
      reconcile: vi.fn((entries) => entries),
    };

    hydrateSessionModel({
      sessionModel,
      payload,
      locationSearch: '?leafId=root&targetId=leaf',
    });

    expect(sessionModel.load).toHaveBeenCalledOnce();
    expect(sessionModel.header.cwd).toBe('/tmp/project');
    expect(sessionModel.leafId).toBe('root');
    expect(sessionModel.urlTargetId).toBe('leaf');

    const runtime = createLiveSessionRuntime({
      sessionModel,
      contentRuntime: { afterRender: null },
      documentImpl: document,
    });

    runtime.navigateTo('leaf', 'none');
    runtime.reconcileEntries([{ id: 'next' }]);

    expect(sessionModel.currentLeafId).toBe('leaf');
    expect(sessionModel.currentTargetId).toBe('leaf');
    expect(sessionModel.reconcile).toHaveBeenCalledWith([{ id: 'next' }]);

    resetSessionRuntimeContext();
  });
});

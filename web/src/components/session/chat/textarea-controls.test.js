import { describe, expect, it, vi } from 'vitest';
import { setupTextareaControls } from './textarea-controls.js';

function createParts() {
  const textarea = document.createElement('textarea');
  const shell = document.createElement('div');
  const form = document.createElement('form');
  form.requestSubmit = vi.fn();
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 120 });
  return { textarea, shell, form };
}

function animationFrames() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    getComputedStyle: vi.fn(() => ({ maxHeight: '200px', minHeight: '48px' })),
    requestAnimationFrame: vi.fn((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id) => callbacks.delete(id)),
    flush() {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach((callback) => callback());
    },
  };
}

describe('setupTextareaControls', () => {
  it('auto-resizes on input without animation frames', () => {
    const parts = createParts();
    const updateSendEnabled = vi.fn();
    const updateComposerHeight = vi.fn();
    setupTextareaControls({
      ...parts,
      updateSendEnabled,
      updateComposerHeight,
      windowImpl: {
        getComputedStyle: () => ({ maxHeight: '200px', minHeight: '48px' }),
      },
    });

    Object.defineProperty(parts.textarea, 'scrollHeight', { value: 140 });
    parts.textarea.dispatchEvent(new Event('input'));

    expect(parts.textarea.style.height).toBe('140px');
    expect(updateSendEnabled).toHaveBeenCalled();
    expect(updateComposerHeight).toHaveBeenCalled();
  });

  it('batches input geometry per frame while updating send state immediately', () => {
    const parts = createParts();
    const windowImpl = animationFrames();
    const updateSendEnabled = vi.fn();
    const updateComposerHeight = vi.fn();
    setupTextareaControls({ ...parts, windowImpl, updateSendEnabled, updateComposerHeight });
    windowImpl.getComputedStyle.mockClear();
    updateSendEnabled.mockClear();
    updateComposerHeight.mockClear();

    Object.defineProperty(parts.textarea, 'scrollHeight', { value: 140 });
    parts.textarea.dispatchEvent(new Event('input'));
    parts.textarea.dispatchEvent(new Event('input'));
    expect(parts.textarea.style.height).toBe('120px');
    expect(updateSendEnabled).toHaveBeenCalledTimes(2);
    expect(windowImpl.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(windowImpl.getComputedStyle).not.toHaveBeenCalled();

    windowImpl.flush();
    expect(parts.textarea.style.height).toBe('140px');
    expect(windowImpl.getComputedStyle).toHaveBeenCalledTimes(1);
    expect(updateComposerHeight).toHaveBeenCalledTimes(1);

    parts.textarea.dispatchEvent(new Event('input'));
    windowImpl.flush();
    expect(updateComposerHeight).toHaveBeenCalledTimes(1);
  });

  it('handles explicit geometry changes immediately and clears pending work on disposal', () => {
    const parts = createParts();
    const windowImpl = animationFrames();
    const updateComposerHeight = vi.fn();
    const { autoResize, dispose } = setupTextareaControls({
      ...parts,
      windowImpl,
      updateComposerHeight,
    });
    updateComposerHeight.mockClear();

    parts.textarea.dispatchEvent(new Event('input'));
    autoResize();
    expect(windowImpl.cancelAnimationFrame).toHaveBeenCalledWith(0);
    expect(parts.textarea.style.height).toBe('120px');
    expect(updateComposerHeight).toHaveBeenCalledTimes(1);
    windowImpl.flush();
    expect(updateComposerHeight).toHaveBeenCalledTimes(1);

    parts.textarea.dispatchEvent(new Event('input'));
    dispose();
    expect(windowImpl.cancelAnimationFrame).toHaveBeenCalledWith(1);
    windowImpl.flush();
    expect(updateComposerHeight).toHaveBeenCalledTimes(1);
  });

  it('submits on desktop Enter but not mobile Enter', () => {
    const desktop = createParts();
    setupTextareaControls({ ...desktop, isMobileTextInputMode: () => false });
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    desktop.textarea.dispatchEvent(enter);
    expect(desktop.form.requestSubmit).toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(true);

    const mobile = createParts();
    setupTextareaControls({ ...mobile, isMobileTextInputMode: () => true });
    const mobileEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    mobile.textarea.dispatchEvent(mobileEnter);
    expect(mobile.form.requestSubmit).not.toHaveBeenCalled();
    expect(mobileEnter.defaultPrevented).toBe(false);
  });

  it('delegates palette keys before submit handling', () => {
    const parts = createParts();
    const slash = { handleKeydown: vi.fn(() => true) };
    setupTextareaControls({ ...parts, getSlashSelector: () => slash });

    parts.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(slash.handleKeydown).toHaveBeenCalled();
    expect(parts.form.requestSubmit).not.toHaveBeenCalled();
  });

  it('handles thinking and model shortcuts', () => {
    const parts = createParts();
    const thinking = { cycle: vi.fn() };
    const model = { open: vi.fn() };
    setupTextareaControls({
      ...parts,
      getThinkingSelector: () => thinking,
      getModelSelector: () => model,
    });

    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    parts.textarea.dispatchEvent(tab);
    expect(thinking.cycle).toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(true);

    const ctrlL = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    parts.textarea.dispatchEvent(ctrlL);
    expect(model.open).toHaveBeenCalled();
    expect(ctrlL.defaultPrevented).toBe(true);
  });
});

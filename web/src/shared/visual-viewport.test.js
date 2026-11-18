import { afterEach, expect, it, vi } from 'vitest';
import { trackVisualViewport } from './visual-viewport.js';
afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
});
it('resizes the whole visible area for a keyboard and ignores page pinch zoom', () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 760, offsetTop: 0, scale: 1 });
  const win = new EventTarget();
  Object.assign(win, {
    visualViewport: viewport,
    innerHeight: 760,
    requestAnimationFrame: vi.fn((fn) => {
      fn();
      return 0;
    }),
    cancelAnimationFrame: vi.fn(),
  });
  const dispose = trackVisualViewport({ windowImpl: win, documentImpl: document });
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.focus();
  viewport.height = 390;
  viewport.offsetTop = 22;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('390px');
  expect(document.documentElement.style.getPropertyValue('--pi-visual-top')).toBe('');
  expect(document.documentElement.classList.contains('pi-keyboard-open')).toBe(true);
  viewport.scale = 2;
  viewport.height = 195;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('390px');
  viewport.scale = 1;
  win.innerHeight = 390;
  viewport.height = 260;
  win.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('390px');
  editor.remove();
  win.innerHeight = 760;
  viewport.height = 760;
  viewport.offsetTop = 500;
  win.dispatchEvent(new Event('pageshow'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-top')).toBe('');
  expect(document.documentElement.classList.contains('pi-keyboard-open')).toBe(false);
  viewport.height = 1;
  win.dispatchEvent(new Event('popstate'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('760px');
  dispose();
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('');
  viewport.height = 300;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('');
});

it('resets a whole-screen standalone iOS pan once without fighting the keyboard', () => {
  const viewport = Object.assign(new EventTarget(), { height: 812, offsetTop: 812, scale: 1 });
  const win = Object.assign(new EventTarget(), {
    navigator: { standalone: true },
    history: { scrollRestoration: 'auto' },
    visualViewport: viewport,
    innerWidth: 402,
    innerHeight: 812,
    requestAnimationFrame: (fn) => {
      fn();
      return 0;
    },
    cancelAnimationFrame: vi.fn(),
    scrollTo: vi.fn(),
  });
  const dispose = trackVisualViewport({ documentImpl: document, windowImpl: win });
  expect(win.history.scrollRestoration).toBe('manual');
  expect(win.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  viewport.dispatchEvent(new Event('scroll'));
  expect(win.scrollTo).toHaveBeenCalledTimes(1);

  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event('scroll'));
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.focus();
  viewport.height = 480;
  viewport.offsetTop = 812;
  viewport.dispatchEvent(new Event('resize'));
  expect(win.scrollTo).toHaveBeenCalledTimes(1);
  editor.blur();
  viewport.height = 812;
  viewport.dispatchEvent(new Event('resize'));
  expect(win.scrollTo).toHaveBeenCalledTimes(2);

  editor.remove();
  dispose();
  expect(win.history.scrollRestoration).toBe('auto');
});

it('blocks native zoom gestures without intercepting taps or scrolling', async () => {
  const { lockPageZoom } = await import('./visual-viewport.js');
  const win = { matchMedia: vi.fn(() => ({ matches: true })) };
  const dispose = lockPageZoom({ windowImpl: win, documentImpl: document });
  const pinch = new Event('touchmove', { cancelable: true });
  Object.defineProperty(pinch, 'touches', { value: [{}, {}] });
  document.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(false);
  const scroll = new Event('touchmove', { cancelable: true });
  Object.defineProperty(scroll, 'touches', { value: [{}] });
  document.dispatchEvent(scroll);
  expect(scroll.defaultPrevented).toBe(false);
  const gesture = new Event('gesturestart', { cancelable: true });
  document.dispatchEvent(gesture);
  expect(gesture.defaultPrevented).toBe(true);
  const doubleTap = new MouseEvent('dblclick', { cancelable: true, bubbles: true });
  document.body.dispatchEvent(doubleTap);
  expect(doubleTap.defaultPrevented).toBe(false);
  const input = document.createElement('input');
  document.body.append(input);
  const edit = new MouseEvent('dblclick', { cancelable: true, bubbles: true });
  input.dispatchEvent(edit);
  expect(edit.defaultPrevented).toBe(false);
  input.remove();
  dispose();
  const after = new Event('gesturestart', { cancelable: true });
  document.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

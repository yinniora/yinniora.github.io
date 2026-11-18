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
  viewport.height = 390;
  viewport.offsetTop = 22;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('390px');
  expect(document.documentElement.style.getPropertyValue('--pi-visual-top')).toBe('22px');
  expect(document.documentElement.classList.contains('pi-keyboard-open')).toBe(true);
  viewport.scale = 2;
  viewport.height = 195;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-height')).toBe('390px');
  viewport.scale = 1;
  viewport.height = 760;
  viewport.offsetTop = 500;
  win.dispatchEvent(new Event('pageshow'));
  expect(document.documentElement.style.getPropertyValue('--pi-visual-top')).toBe('0px');
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

it('blocks phone pinch and double-tap page zoom while keeping one-finger scrolling and text editing', async () => {
  const { lockPageZoom } = await import('./visual-viewport.js');
  const win = { matchMedia: vi.fn(() => ({ matches: true })) };
  const dispose = lockPageZoom({ windowImpl: win, documentImpl: document });
  const pinch = new Event('touchmove', { cancelable: true });
  Object.defineProperty(pinch, 'touches', { value: [{}, {}] });
  document.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(true);
  const scroll = new Event('touchmove', { cancelable: true });
  Object.defineProperty(scroll, 'touches', { value: [{}] });
  document.dispatchEvent(scroll);
  expect(scroll.defaultPrevented).toBe(false);
  const gesture = new Event('gesturestart', { cancelable: true });
  document.dispatchEvent(gesture);
  expect(gesture.defaultPrevented).toBe(true);
  const doubleTap = new MouseEvent('dblclick', { cancelable: true, bubbles: true });
  document.body.dispatchEvent(doubleTap);
  expect(doubleTap.defaultPrevented).toBe(true);
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

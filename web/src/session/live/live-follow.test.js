import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createFollowScrollController } from './live-follow.js';

function setup({ scrollHeight = 2000, innerHeight = 1000 } = {}) {
  const dom = new JSDOM('<body><main id="content"></main></body>');
  const documentImpl = dom.window.document;
  const content = documentImpl.getElementById('content');
  Object.defineProperty(content, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(content, 'clientHeight', { value: innerHeight });
  content.scrollTo = vi.fn();

  const handlers = {};
  const windowImpl = {
    scrollY: 0,
    pageYOffset: 0,
    innerHeight,
    scrollTo: vi.fn(),
    setTimeout: (cb) => {
      cb();
      return 0;
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    addEventListener: (type, handler) => {
      (handlers[type] ||= []).push(handler);
    },
    removeEventListener: (type, handler) => {
      handlers[type] = (handlers[type] || []).filter((h) => h !== handler);
    },
  };
  const fire = (type, extra = {}) => {
    if (type === 'scroll') content.dispatchEvent(new dom.window.Event('scroll'));
    else (handlers[type] || []).forEach((h) => h({ type, ...extra }));
  };

  const controller = createFollowScrollController({
    documentImpl,
    windowImpl,
    requestAnimationFrameImpl: (cb) => {
      cb();
      return 0;
    },
    setTimeoutImpl: (cb) => {
      cb();
      return 0;
    },
  });
  return { content, documentImpl, fire, controller };
}

describe('createFollowScrollController', () => {
  it('starts following and scrolls to bottom on init', () => {
    const { content, controller } = setup();
    expect(controller.isFollowing()).toBe(true);
    expect(controller.shouldFollow()).toBe(true);
    expect(content.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('stops following and shows the follow button when scrolled away from bottom', () => {
    const { documentImpl, content, fire, controller } = setup();
    content.scrollTop = 0; // remaining = 2000 - 0 - 1000 = 1000 (> threshold)
    fire('scroll');
    expect(controller.isFollowing()).toBe(false);
    expect(documentImpl.querySelector('.follow-button')).not.toBeNull();
  });

  it('keeps following on a downward scrollTop clamp that stays at the bottom', () => {
    const { documentImpl, content, fire, controller } = setup();
    content.scrollTop = 1000; // remaining = 2000 - 1000 - 1000 = 0 (at bottom)
    fire('scroll');
    expect(controller.isFollowing()).toBe(true);
    // The transcript shrinks when the streaming preview is finalized/removed, so
    // the browser clamps scrollTop downward — but we are still at the bottom.
    content.scrollTop = 960; // remaining = 40 (< 80 threshold, still at bottom)
    fire('scroll');
    expect(controller.isFollowing()).toBe(true);
    expect(documentImpl.querySelector('.follow-button')).toBeNull();
  });

  it('releases forced follow when the user scrolls up away from the bottom', () => {
    const { content, fire, controller } = setup();
    content.scrollTop = 1000;
    fire('scroll');
    controller.extendPreviewFollow(30000);
    expect(controller.shouldFollow()).toBe(true);
    content.scrollTop = 0; // remaining = 1000 (away from bottom) and scrolled up
    fire('scroll');
    expect(controller.isFollowing()).toBe(false);
    expect(controller.shouldFollow()).toBe(false);
  });

  it('clicking the follow button re-follows and removes the button', () => {
    const { documentImpl, content, fire, controller } = setup();
    fire('scroll');
    const btn = documentImpl.querySelector('.follow-button');
    expect(btn).not.toBeNull();
    content.scrollTo.mockClear();
    btn.click();
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    expect(documentImpl.querySelector('.follow-button')).toBeNull();
    expect(controller.isFollowing()).toBe(true);
  });

  it('extendPreviewFollow keeps shouldFollow true while not following', () => {
    const { fire, controller } = setup();
    fire('scroll'); // following becomes false
    expect(controller.shouldFollow()).toBe(false);
    controller.extendPreviewFollow(30000);
    expect(controller.shouldFollow()).toBe(true);
  });

  it('forceFollowToBottom re-follows and scrolls', () => {
    const { content, fire, controller } = setup();
    fire('scroll');
    expect(controller.isFollowing()).toBe(false);
    content.scrollTo.mockClear();
    controller.forceFollowToBottom(true);
    expect(controller.isFollowing()).toBe(true);
    expect(content.scrollTo).toHaveBeenCalled();
  });

  it('ignores non-scrolling keys for follow decisions', () => {
    const { fire, controller } = setup();
    fire('keydown', { key: 'a' });
    expect(controller.isFollowing()).toBe(true);
  });

  it('dispose removes listeners so later scrolls no longer change state', () => {
    const { fire, controller } = setup();
    controller.dispose();
    fire('scroll');
    expect(controller.isFollowing()).toBe(true);
  });
});

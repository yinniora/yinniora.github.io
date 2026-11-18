import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  createFollowButton,
  isAtBottom,
  removeFollowButton,
  scrollElementAboveComposer,
  scrollToBottom,
  setFollowButtonText,
} from './live-scroll.js';

describe('live scroll helpers', () => {
  it('creates, labels, and removes follow button', () => {
    const dom = new JSDOM('<body><main id="content"></main></body>');
    const btn = createFollowButton({
      documentImpl: dom.window.document,
      requestAnimationFrameImpl: (cb) => cb(),
    });
    setFollowButtonText(btn, 2);
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Scroll to bottom');
    expect(dom.window.document.body.contains(btn)).toBe(true);
    removeFollowButton(btn, { windowImpl: { setTimeout: (cb) => cb() } });
    expect(dom.window.document.body.contains(btn)).toBe(false);
  });

  it('scrolls the transcript alone even when the document reports a second screen', () => {
    const dom = new JSDOM('<body><main id="content"><p>Reply</p></main></body>');
    const doc = dom.window.document;
    const content = doc.getElementById('content');
    const reply = content.firstElementChild;
    const windowImpl = { scrollTo: vi.fn(), innerHeight: 812 };
    content.scrollTo = vi.fn();
    Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 1624 });
    Object.defineProperty(content, 'scrollHeight', { value: 3000 });
    Object.defineProperty(content, 'clientHeight', { value: 600 });

    scrollToBottom(false, { documentImpl: doc, windowImpl });
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'auto' });

    content.scrollTop = 2200;
    content.getBoundingClientRect = () => ({ bottom: 740 });
    reply.getBoundingClientRect = () => ({ bottom: 780 });
    scrollElementAboveComposer(reply, true, { documentImpl: doc, windowImpl });
    expect(content.scrollTo).toHaveBeenLastCalledWith({ top: 2264, behavior: 'smooth' });

    content.scrollTop = 2400;
    expect(isAtBottom({ documentImpl: doc, windowImpl })).toBe(true);
    expect(windowImpl.scrollTo).not.toHaveBeenCalled();
  });

  it('uses the document fallback when there is no transcript', () => {
    const { document: doc } = new JSDOM('<body></body>').window;
    const scrollTo = vi.fn();
    Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 1200 });
    scrollToBottom(true, { documentImpl: doc, windowImpl: { scrollTo } });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
  });

  it('detects isAtBottom for window scroll and content scroll', () => {
    // Scenario 1: Window scrollable (Desktop)
    const domWindow = new JSDOM('<body></body>');
    const docWindow = domWindow.window.document;
    Object.defineProperty(docWindow.documentElement, 'scrollHeight', {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(docWindow.body, 'scrollHeight', { value: 2000, configurable: true });

    // Scrolled to bottom
    const winAtBottom = {
      scrollY: 1000,
      innerHeight: 1000,
    };
    expect(isAtBottom({ documentImpl: docWindow, windowImpl: winAtBottom, threshold: 80 })).toBe(
      true,
    );

    // Scrolled up
    const winScrolledUp = {
      scrollY: 500,
      innerHeight: 1000,
    };
    expect(isAtBottom({ documentImpl: docWindow, windowImpl: winScrolledUp, threshold: 80 })).toBe(
      false,
    );

    // Scenario 2: Content scrollable (Mobile)
    const domContent = new JSDOM('<body><main id="content"></main></body>');
    const docContent = domContent.window.document;
    const contentEl = docContent.getElementById('content');
    Object.defineProperty(docContent.documentElement, 'scrollHeight', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(docContent.body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(contentEl, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(contentEl, 'clientHeight', { value: 800, configurable: true });

    const winMobile = {
      scrollY: 0,
      innerHeight: 1000,
    };

    // Content scrolled to bottom
    contentEl.scrollTop = 4200;
    expect(isAtBottom({ documentImpl: docContent, windowImpl: winMobile, threshold: 80 })).toBe(
      true,
    );

    // Content scrolled up
    contentEl.scrollTop = 1000;
    expect(isAtBottom({ documentImpl: docContent, windowImpl: winMobile, threshold: 80 })).toBe(
      false,
    );
  });
});

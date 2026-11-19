import { describe, expect, it } from 'vitest';
import { installExternalLinks, prepareExternalLink } from './external-links.js';

function click(anchor, init = {}) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  anchor.dispatchEvent(event);
  return event;
}

describe('external links', () => {
  it('opens other sites in a new window without blocking the click', () => {
    document.body.innerHTML = '<p><a href="https://example.com/a"><b>x</b></a></p>';
    const stop = installExternalLinks();
    const anchor = document.querySelector('a');
    anchor.addEventListener('click', (event) => event.preventDefault()); // jsdom: no navigation
    click(anchor.querySelector('b'));
    expect(anchor.target).toBe('_blank');
    expect(anchor.rel).toBe('noopener noreferrer');
    stop();
  });

  it('leaves in-app, hash, download and non-web links alone', () => {
    const location = new URL('https://app.test/session?id=1');
    for (const html of [
      '<a href="/settings">s</a>',
      '<a href="https://app.test/x">s</a>',
      '<a href="#top">s</a>',
      '<a href="https://example.com/f" download>s</a>',
      '<a href="mailto:a@b.c">s</a>',
    ]) {
      document.body.innerHTML = html;
      const anchor = document.querySelector('a');
      expect(prepareExternalLink({ target: anchor, button: 0 }, { location })).toBe(false);
      expect(anchor.target).toBe('');
    }
  });

  it('respects clicks other handlers already took', () => {
    document.body.innerHTML = '<a href="https://example.com">x</a>';
    const anchor = document.querySelector('a');
    expect(prepareExternalLink({ target: anchor, button: 0, defaultPrevented: true })).toBe(false);
  });
});

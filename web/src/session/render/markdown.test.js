import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { configureSessionMarkdown, safeMarkedParse, strictStrikethroughRegex } from './markdown.js';

describe('session markdown', () => {
  it('matches only strict strikethrough markers', () => {
    expect(strictStrikethroughRegex.test('~~gone~~')).toBe(true);
    expect(strictStrikethroughRegex.test('~~ spaced ~~')).toBe(false);
  });

  it('sanitizes unsafe links and treats html as text', () => {
    const instance = new Marked();
    configureSessionMarkdown({
      marked: instance,
      hljs,
      escapeHtml: (text) =>
        String(text).replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    });

    expect(safeMarkedParse('[x](javascript:alert(1))', { marked: instance })).not.toContain(
      'href=',
    );
    expect(safeMarkedParse('<script>alert(1)</script>', { marked: instance })).toContain(
      '&lt;script&gt;',
    );
  });

  it('renders code blocks through highlight.js wrapper', () => {
    const instance = new Marked();
    configureSessionMarkdown({ marked: instance, hljs, escapeHtml: (text) => String(text) });
    expect(safeMarkedParse('```js\nconst x = 1;\n```', { marked: instance })).toContain(
      'class="hljs"',
    );
  });

  it('renders embedded raster images without allowing other data URLs', () => {
    const marked = new Marked();
    expect(safeMarkedParse('![PNG](data:image/png;base64,YWJj)', { marked })).toContain(
      '<img src="data:image/png;base64,YWJj" alt="PNG">',
    );
    expect(safeMarkedParse('![SVG](data:image/svg+xml;base64,YWJj)', { marked })).not.toContain(
      '<img',
    );
    expect(safeMarkedParse('[Data](data:image/png;base64,YWJj)', { marked })).not.toContain(
      'href=',
    );
  });

  it('keeps workspace downloads inside the live session and leaves export anchors alone', () => {
    const instance = new Marked();
    const inputs =
      '[Download](./drawing%20test.svg) [Outside](../other.svg) [Website](https://example.com/a.svg) [Settings](/settings)';
    const html = safeMarkedParse(inputs, { marked: instance, workspaceCwd: '/work' });
    expect(html).toContain('data-session-file="drawing test.svg"');
    expect(html).toContain('data-session-file="" data-filename="other.svg"');
    expect(html).not.toContain('href="./drawing%20test.svg"');
    expect(html).toContain('href="https://example.com/a.svg"');
    expect(html).toContain('href="/settings"');
    expect(safeMarkedParse(inputs, { marked: instance })).toContain('href="./drawing%20test.svg"');
  });
});

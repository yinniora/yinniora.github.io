import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { indexOutputFiles } from '../artifacts/outputs.js';
import {
  configureSessionMarkdown,
  replyMarkdownParts,
  safeMarkedParse,
  strictStrikethroughRegex,
} from './markdown.js';

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

  it('puts a file beside its first actual mention and ignores examples and external links', () => {
    const marked = new Marked();
    const cwd = '/work';
    const files = ['drawing test.svg', 'main/README', 'logs/a.txt', 'logs/b/a.txt', 'code.js'].map(
      (path) => ({ path }),
    );
    const fileIndex = indexOutputFiles(files, cwd);
    const source = [
      '[code.js](https://example.com/code.js) and ambiguous `a.txt`',
      '```sh\ncat code.js\n```',
      '图示 ![Drawing](./drawing%20test.svg)',
      '编译说明在 `README`，日志在 `logs/b/a.txt`。',
      'Already attached: `drawing test.svg`.',
    ].join('\n\n');
    const parts = replyMarkdownParts(source, { marked, cwd, fileIndex }, new Set());
    expect(parts.map(({ files }) => files.map(({ path }) => path))).toEqual([
      ['drawing test.svg'],
      ['main/README', 'logs/b/a.txt'],
      [],
    ]);
    expect(parts[0].html).toContain('data-session-file="drawing test.svg"');
    expect(parts[0].html).toContain('href="https://example.com/code.js"');
    expect(parts[1].html).toContain('编译说明在');
    expect(parts[2].html).toContain('Already attached');
  });
});

import { localOutputLink } from '../artifacts/outputs.js';
import { escapeHtml as defaultEscapeHtml } from '../../shared/escape.js';

export const strictStrikethroughRegex =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

const configured = new WeakSet();

export function configureSessionMarkdown({ marked, hljs, escapeHtml = defaultEscapeHtml }) {
  if (configured.has(marked)) return;
  marked.use({
    breaks: true,
    gfm: true,
    tokenizer: {
      html() {
        return undefined;
      },
      tag() {
        return undefined;
      },
      del(src) {
        const match = strictStrikethroughRegex.exec(src);
        if (!match) return undefined;
        return {
          type: 'del',
          raw: match[0],
          text: match[2],
          tokens: this.lexer.inlineTokens(match[2]),
        };
      },
    },
    renderer: {
      link(token) {
        const href = (token.href || '').trim();
        const label = this.parser.parseInline(token.tokens);
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          return label;
        }
        if (typeof this.options.workspaceCwd === 'string') {
          const file = localOutputLink(href, this.options.workspaceCwd);
          if (file) {
            return (
              '<button type="button" class="session-file-link" data-session-file="' +
              escapeHtml(file.path) +
              '" data-filename="' +
              escapeHtml(file.title) +
              '">' +
              label +
              '</button>'
            );
          }
        }
        let out = '<a href="' + escapeHtml(href) + '"';
        if (token.title) {
          out += ' title="' + escapeHtml(token.title) + '"';
        }
        out += '>' + label + '</a>';
        return out;
      },
      image(token) {
        const href = (token.href || '').trim();
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          return escapeHtml(token.text || '');
        }
        let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '"';
        if (token.title) {
          out += ' title="' + escapeHtml(token.title) + '"';
        }
        out += '>';
        return out;
      },
      code(token) {
        const code = token.text;
        const lang = token.lang;
        if (hljs) {
          let highlighted;
          if (lang && hljs.getLanguage(lang)) {
            try {
              highlighted = hljs.highlight(code, { language: lang }).value;
            } catch {
              highlighted = escapeHtml(code);
            }
          } else {
            try {
              highlighted = hljs.highlightAuto(code).value;
            } catch {
              highlighted = escapeHtml(code);
            }
          }
          return `<pre><code class="hljs">${highlighted}</code></pre>`;
        }
        // hljs not yet loaded: plain text, marked for lazy highlighting
        const dataLang = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
        return `<pre><code class="hljs" data-highlight-pending${dataLang}>${escapeHtml(code)}</code></pre>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      },
    },
  });
  configured.add(marked);
}

export function safeMarkedParse(text, { marked, workspaceCwd }) {
  configureSessionMarkdown({ marked });
  return marked.parse(text, typeof workspaceCwd === 'string' ? { workspaceCwd } : undefined);
}

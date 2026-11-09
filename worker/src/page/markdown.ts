// A small Markdown renderer for text Dub shows on the review page: the brief
// an agent wrote and the summary the Worker generated. Everything is escaped
// first and only tags this file emits reach the page, so neither source can
// smuggle markup in. Supports headings, paragraphs, bullet and numbered lists,
// fenced code, blockquotes, bold, italics, inline code and http(s) links.
import { esc } from './html';

export interface MarkdownOptions {
  /** Shift heading levels down, so a brief's `#` renders as an `h3` inside a panel. */
  headingShift?: number;
}

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const shift = opts.headingShift ?? 0;
  const lines = stripFrontmatter(src).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!), i++;
      i++; // closing fence (or EOF)
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, h[1]!.length + shift);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        let text = m[1]!;
        i++;
        // Continuation lines are indented and not themselves items.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!)) text += ' ' + lines[i]!.trim(), i++;
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) quote.push(lines[i]!.replace(/^\s*>\s?/, '')), i++;
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'), opts)}</blockquote>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

function stripFrontmatter(src: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

/** Inline markup over already-escaped text. */
export function inline(raw: string): string {
  let s = esc(raw);
  // Code spans first so their contents are left alone.
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[Number(n)]!);
  return s;
}

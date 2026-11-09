import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/page/markdown';

describe('renderMarkdown', () => {
  it('renders the brief shapes: frontmatter, headings, lists, emphasis', () => {
    const html = renderMarkdown('---\nid: x\n---\n# Title\n\n**Why:** reasons.\n\n## Acceptance\n- [ac-1] One `code` {kind: check}\n- [ac-2] Two\n\n1. first\n2. second', { headingShift: 2 });
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<h4>Acceptance</h4>');
    expect(html).toContain('<p><strong>Why:</strong> reasons.</p>');
    expect(html).toContain('<ul><li>[ac-1] One <code>code</code> {kind: check}</li><li>[ac-2] Two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).not.toContain('id: x');
  });

  it('escapes everything and only links http(s)', () => {
    const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com) `<b>`');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });

  it('renders fenced code and blockquotes', () => {
    const html = renderMarkdown('> quoted **bold**\n\n```\nx < y\n```');
    expect(html).toContain('<blockquote><p>quoted <strong>bold</strong></p></blockquote>');
    expect(html).toContain('<pre><code>x &lt; y</code></pre>');
  });
});

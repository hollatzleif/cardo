import { describe, expect, it } from 'vitest';
import { escapeHtml, renderInline, renderMarkdown } from './markdown';

describe('escapeHtml', () => {
  it('escapes all HTML-relevant characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown – blocks', () => {
  it('renders headings # through ###', () => {
    expect(renderMarkdown('# One')).toBe('<h1>One</h1>');
    expect(renderMarkdown('## Two')).toBe('<h2>Two</h2>');
    expect(renderMarkdown('### Three')).toBe('<h3>Three</h3>');
  });

  it('splits paragraphs on blank lines and joins soft-wrapped lines', () => {
    expect(renderMarkdown('first line\nstill first\n\nsecond')).toBe(
      '<p>first line still first</p>\n<p>second</p>',
    );
  });

  it('renders unordered lists from - and *', () => {
    expect(renderMarkdown('- a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders ordered lists', () => {
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('keeps code fences verbatim, without inline formatting', () => {
    expect(renderMarkdown('```\n**not bold** <b>\n```')).toBe(
      '<pre><code>**not bold** &lt;b&gt;</code></pre>',
    );
  });

  it('survives an unclosed code fence', () => {
    expect(renderMarkdown('```\nabc')).toBe('<pre><code>abc</code></pre>');
  });
});

describe('renderInline', () => {
  it('operates on pre-escaped text and combines code, bold and links', () => {
    expect(renderInline('mix `a` **b** [c](https://e.com)')).toBe(
      'mix <code>a</code> <strong>b</strong> <a href="https://e.com" target="_blank" rel="noopener noreferrer">c</a>',
    );
  });

  it('cannot be forged with placeholder sentinel characters', () => {
    expect(renderInline('x\uE0000\uE000y')).toBe('x0y');
  });
});

describe('renderMarkdown – inline', () => {
  it('renders bold, italic and inline code', () => {
    expect(renderMarkdown('**b** and *i* and _u_ and `c`')).toBe(
      '<p><strong>b</strong> and <em>i</em> and <em>u</em> and <code>c</code></p>',
    );
  });

  it('does not format Markdown syntax inside inline code', () => {
    expect(renderMarkdown('`**still literal**`')).toBe('<p><code>**still literal**</code></p>');
  });

  it('renders http/https/mailto links with safe rel attributes', () => {
    expect(renderMarkdown('[Cardo](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">Cardo</a></p>',
    );
  });

  it('applies inline formatting inside headings and list items', () => {
    expect(renderMarkdown('# A **big** day')).toBe('<h1>A <strong>big</strong> day</h1>');
    expect(renderMarkdown('- `code` item')).toBe('<ul><li><code>code</code> item</li></ul>');
  });
});

describe('renderMarkdown – XSS hardening', () => {
  it('escapes script tags instead of emitting them', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes event-handler injection attempts', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('refuses javascript: and data: link targets', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[x](data:text/html;base64,AAAA)')).not.toContain('<a ');
  });

  it('cannot be tricked into breaking out of the href attribute', () => {
    const out = renderMarkdown('[x](https://e.com/"onmouseover="alert(1))');
    expect(out).not.toContain('"onmouseover="');
  });
});

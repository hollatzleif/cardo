import React from 'react';
import { renderMathHtml } from '@cardo/ui';

/**
 * Tiny Markdown renderer → React nodes. User text becomes React children
 * (never dangerouslySetInnerHTML), so raw HTML stays inert. The ONE exception
 * is LaTeX: $…$/$$…$$ are handed to KaTeX (trust:false → safe markup) and
 * injected as HTML. Supports headings, bold, italic, inline code, links,
 * fenced code blocks, unordered/ordered lists, math and [[wiki-links]].
 */

/** True when a $…$ body actually looks like math (so prices like "$5" stay text). */
function looksLikeMath(tex: string): boolean {
  return /[\\^_{}]/.test(tex);
}

function MathSpan({ tex, display }: { tex: string; display: boolean }): React.ReactElement {
  return (
    <span
      className={display ? 'fx-math-display' : 'fx-math'}
      // KaTeX output with trust:false is safe; this is the only HTML we inject.
      dangerouslySetInnerHTML={{ __html: renderMathHtml(tex, display) }}
    />
  );
}

const WIKI = /\[\[([^\]]+)\]\]/g;

/** Extracts the target names of every [[wiki-link]] in the text (deduped). */
export function extractWikiLinks(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(WIKI)) {
    const name = m[1]?.split('|')[0]?.trim();
    if (name) out.add(name);
  }
  return [...out];
}

/** True if `md` links to `target` via [[target]] (case-insensitive, .md-agnostic). */
export function linksTo(md: string, target: string): boolean {
  const want = target.replace(/\.md$/i, '').toLowerCase();
  return extractWikiLinks(md).some((l) => l.toLowerCase() === want);
}

/** Renders inline spans: **bold**, *italic*, `code`, [t](u), [[wiki]]. */
function inline(text: string, onWiki: (name: string) => void, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on the tokens we understand, keeping the delimiters. Math ($$…$$
  // before $…$) comes first so its $, \, {} never collide with the rest.
  const re =
    /(\$\$[^\n]+?\$\$|\$[^\n$]+?\$|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A $…$ that isn't really math is left as literal text (skip the token).
    if (m[0].startsWith('$') && !m[0].startsWith('$$') && !looksLikeMath(m[0].slice(1, -1))) {
      continue;
    }
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('$$')) {
      nodes.push(<MathSpan key={key} tex={tok.slice(2, -2)} display />);
    } else if (tok.startsWith('$')) {
      nodes.push(<MathSpan key={key} tex={tok.slice(1, -1)} display={false} />);
    } else if (tok.startsWith('[[')) {
      const raw = tok.slice(2, -2);
      const [nameRaw, label] = raw.split('|');
      const name = (nameRaw ?? '').trim();
      nodes.push(
        <a
          key={key}
          className="fx-wikilink"
          role="button"
          tabIndex={0}
          onClick={() => onWiki(name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onWiki(name);
          }}
          style={{
            color: 'var(--accent)',
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
            cursor: 'pointer',
          }}
        >
          {(label ?? name).trim()}
        </a>,
      );
    } else if (tok.startsWith('[')) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      nodes.push(
        <a
          key={key}
          href={mm?.[2]}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--accent)' }}
        >
          {mm?.[1]}
        </a>,
      );
    } else if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          style={{
            background: 'var(--bg-widget-hover)',
            padding: '0.1em 0.35em',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: '0.9em',
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({
  source,
  onWikiLink,
}: {
  source: string;
  onWikiLink: (name: string) => void;
}): React.ReactElement {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let math: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, onWikiLink, `li${key}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (code === null) {
        flushList();
        code = [];
      } else {
        blocks.push(
          <pre
            key={key++}
            className="fx-code"
            style={{
              background: 'var(--bg-widget-hover)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: '0.9em',
            }}
          >
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(raw);
      continue;
    }
    // Block math fence: a line that is exactly "$$" opens a display block
    // until the next "$$" (single-line "$$…$$" is handled inline instead).
    if (raw.trim() === '$$') {
      if (math === null) {
        flushList();
        math = [];
      } else {
        blocks.push(<MathSpan key={key++} tex={math.join('\n')} display />);
        math = null;
      }
      continue;
    }
    if (math !== null) {
      math.push(raw);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(raw);
    const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (heading) {
      flushList();
      const level = (heading[1] ?? '#').length;
      const Tag = (`h${level}` as unknown) as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={key++} className="fx-h">
          {inline(heading[2] ?? '', onWikiLink, `h${key}`)}
        </Tag>,
      );
    } else if (ul || ol) {
      const ordered = ol != null;
      const item = (ul?.[1] ?? ol?.[1]) as string;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
    } else if (raw.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={key++} className="fx-p">
          {inline(raw, onWikiLink, `p${key}`)}
        </p>,
      );
    }
  }
  flushList();
  if (code !== null) {
    blocks.push(
      <pre key={key++} className="fx-code">
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }
  if (math !== null && math.length > 0) {
    blocks.push(<MathSpan key={key++} tex={math.join('\n')} display />);
  }
  return <div className="fx-markdown">{blocks}</div>;
}

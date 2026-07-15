/**
 * Pure logic for the snippets tool: a tiny line-based syntax highlighter
 * (keyword lists + string/comment scanning, NO external lib), filtering and
 * the assistant context. The highlighter's invariant: joining the span
 * texts of a line reproduces the line exactly.
 */

import { z } from 'zod';

export type SnippetDoc = {
  /** Stable id, identical to the storage doc id ("snippet:<random>"). */
  id: string;
  type: 'snippet';
  title: string;
  /** Canonical language id (see LANGUAGE_IDS) or free text for "plain". */
  language: string;
  body: string;
  tags: string[];
  createdAt: string;
};

export const addSnippetParamsSchema = z.object({
  title: z.string().min(1),
  language: z.string().min(1),
  body: z.string().min(1),
  /** Comma-separated tag list. */
  tags: z.string().optional(),
});
export type AddSnippetParams = z.infer<typeof addSnippetParamsSchema>;

export function makeSnippetId(): string {
  return `snippet:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "a, B ,, a" → ["a", "B"] (trimmed, case-insensitively deduped). */
export function splitTags(input?: string): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export function makeSnippet(
  input: { title: string; language: string; body: string; tags?: string[] },
  now: Date = new Date(),
): SnippetDoc {
  return {
    id: makeSnippetId(),
    type: 'snippet',
    title: input.title.trim(),
    language: normalizeLanguage(input.language) ?? input.language.trim().toLowerCase(),
    body: input.body,
    tags: input.tags ?? [],
    createdAt: now.toISOString(),
  };
}

/* ── Highlighter ──────────────────────────────────────────────────────── */

export type SpanKind = 'code' | 'comment' | 'string' | 'keyword';
export type Span = { text: string; kind: SpanKind };

type LangConfig = {
  lineComments: string[];
  blockComment?: [open: string, close: string];
  stringQuotes: string[];
  keywords: readonly string[];
};

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var',
  'void', 'while', 'yield',
] as const;

const LANGUAGES: Record<string, LangConfig> = {
  js: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    stringQuotes: ["'", '"', '`'],
    keywords: JS_KEYWORDS,
  },
  ts: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    stringQuotes: ["'", '"', '`'],
    keywords: [
      ...JS_KEYWORDS, 'abstract', 'any', 'as', 'boolean', 'declare', 'enum', 'implements',
      'interface', 'keyof', 'namespace', 'never', 'number', 'private', 'protected',
      'public', 'readonly', 'satisfies', 'string', 'type', 'unknown',
    ],
  },
  python: {
    lineComments: ['#'],
    stringQuotes: ["'", '"'],
    keywords: [
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
      'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if',
      'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise',
      'return', 'True', 'try', 'while', 'with', 'yield',
    ],
  },
  rust: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    stringQuotes: ['"'],
    keywords: [
      'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
      'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move',
      'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true',
      'type', 'unsafe', 'use', 'where', 'while',
    ],
  },
  css: {
    lineComments: [],
    blockComment: ['/*', '*/'],
    stringQuotes: ["'", '"'],
    keywords: [
      'align', 'background', 'border', 'color', 'display', 'flex', 'font', 'gap', 'grid',
      'height', 'important', 'imports', 'keyframes', 'margin', 'media', 'padding',
      'position', 'root', 'supports', 'transform', 'transition', 'width',
    ],
  },
  html: {
    lineComments: [],
    blockComment: ['<!--', '-->'],
    stringQuotes: ["'", '"'],
    keywords: [
      'a', 'body', 'button', 'div', 'form', 'head', 'html', 'img', 'input', 'li', 'link',
      'main', 'meta', 'nav', 'p', 'script', 'section', 'span', 'style', 'table', 'ul',
    ],
  },
  json: {
    lineComments: [],
    stringQuotes: ['"'],
    keywords: ['false', 'null', 'true'],
  },
  shell: {
    lineComments: ['#'],
    stringQuotes: ["'", '"'],
    keywords: [
      'case', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for',
      'function', 'if', 'in', 'local', 'read', 'return', 'set', 'then', 'until', 'while',
    ],
  },
};

const LANGUAGE_ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  node: 'js',
  typescript: 'ts',
  tsx: 'ts',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  scss: 'css',
  htm: 'html',
  xml: 'html',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
};

/** Canonical, UI-facing language ids (order = select order). */
export const LANGUAGE_IDS = Object.keys(LANGUAGES);

/** Canonical language id, or null when unknown (→ plain rendering). */
export function normalizeLanguage(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (key in LANGUAGES) return key;
  const alias = LANGUAGE_ALIASES[key];
  return alias ?? null;
}

/** Merge adjacent spans of the same kind and drop empties. */
function pushSpan(spans: Span[], text: string, kind: SpanKind): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.kind === kind) last.text += text;
  else spans.push({ text, kind });
}

/** Split a raw code segment into keyword/code spans by word boundaries. */
function pushCode(spans: Span[], text: string, keywords: ReadonlySet<string>): void {
  if (!text) return;
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
  let cursor = 0;
  for (const match of text.matchAll(wordRe)) {
    const word = match[0];
    const at = match.index ?? 0;
    if (keywords.has(word)) {
      pushSpan(spans, text.slice(cursor, at), 'code');
      pushSpan(spans, word, 'keyword');
      cursor = at + word.length;
    }
  }
  pushSpan(spans, text.slice(cursor), 'code');
}

/**
 * Line-based tokenizer: per input line an array of spans. Strings win over
 * comment markers ("http://…" inside a string is NOT a comment), block
 * comments carry across lines, unknown languages fall back to plain code.
 */
export function highlightLines(body: string, language: string): Span[][] {
  const canonical = normalizeLanguage(language);
  const lines = body.split('\n');
  if (!canonical) return lines.map((line) => (line ? [{ text: line, kind: 'code' }] : []));
  const config = LANGUAGES[canonical];
  if (!config) return lines.map((line) => (line ? [{ text: line, kind: 'code' }] : []));
  const keywords: ReadonlySet<string> = new Set(config.keywords);
  const [blockOpen, blockClose] = config.blockComment ?? [null, null];

  let inBlockComment = false;
  const result: Span[][] = [];

  for (const line of lines) {
    const spans: Span[] = [];
    let i = 0;
    let codeStart = 0;

    const flushCode = (end: number) => {
      pushCode(spans, line.slice(codeStart, end), keywords);
    };

    if (inBlockComment && blockClose) {
      const close = line.indexOf(blockClose);
      if (close === -1) {
        pushSpan(spans, line, 'comment');
        result.push(spans);
        continue;
      }
      pushSpan(spans, line.slice(0, close + blockClose.length), 'comment');
      inBlockComment = false;
      i = close + blockClose.length;
      codeStart = i;
    }

    scan: while (i < line.length) {
      const ch = line[i];
      if (ch === undefined) break;

      // Strings first – comment markers inside a string are literal text.
      if (config.stringQuotes.includes(ch)) {
        flushCode(i);
        let j = i + 1;
        while (j < line.length) {
          const c = line[j];
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === ch) break;
          j += 1;
        }
        const end = j < line.length ? j + 1 : line.length; // unterminated → EOL
        pushSpan(spans, line.slice(i, end), 'string');
        i = end;
        codeStart = i;
        continue;
      }

      for (const marker of config.lineComments) {
        if (line.startsWith(marker, i)) {
          flushCode(i);
          pushSpan(spans, line.slice(i), 'comment');
          i = line.length;
          codeStart = i;
          continue scan;
        }
      }

      if (blockOpen && blockClose && line.startsWith(blockOpen, i)) {
        flushCode(i);
        const close = line.indexOf(blockClose, i + blockOpen.length);
        if (close === -1) {
          pushSpan(spans, line.slice(i), 'comment');
          inBlockComment = true;
          i = line.length;
        } else {
          pushSpan(spans, line.slice(i, close + blockClose.length), 'comment');
          i = close + blockClose.length;
        }
        codeStart = i;
        continue;
      }

      i += 1;
    }

    flushCode(line.length);
    result.push(spans);
  }

  return result;
}

/* ── Filtering / tags / context ───────────────────────────────────────── */

/**
 * Free-text query over title, body, language and tags (case-insensitive),
 * plus an optional exact tag filter. Empty query/tag pass everything.
 */
export function filterSnippets(
  snippets: SnippetDoc[],
  query: string,
  tag?: string,
): SnippetDoc[] {
  const q = query.trim().toLowerCase();
  const tagKey = tag?.trim().toLowerCase() ?? '';
  return snippets.filter((snippet) => {
    if (tagKey && !snippet.tags.some((own) => own.toLowerCase() === tagKey)) return false;
    if (!q) return true;
    return (
      snippet.title.toLowerCase().includes(q) ||
      snippet.body.toLowerCase().includes(q) ||
      snippet.language.toLowerCase().includes(q) ||
      snippet.tags.some((own) => own.toLowerCase().includes(q))
    );
  });
}

/** Unique tags (first casing wins), sorted alphabetically. */
export function allTags(snippets: SnippetDoc[]): string[] {
  const seen = new Map<string, string>();
  for (const snippet of snippets) {
    for (const tag of snippet.tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Assistant context: count, languages and the newest titles. */
export function buildSnippetsContext(snippets: SnippetDoc[], language: string): string {
  const de = language === 'de';
  if (snippets.length === 0) return de ? 'Keine Snippets gespeichert.' : 'No snippets saved.';
  const newest = [...snippets]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3)
    .map((snippet) => `«${snippet.title}» (${snippet.language})`);
  return de
    ? `${snippets.length} Snippets gespeichert. Neueste: ${newest.join(', ')}.`
    : `${snippets.length} snippets saved. Newest: ${newest.join(', ')}.`;
}

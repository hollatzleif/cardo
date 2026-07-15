/**
 * Pure, storage-free logic for the decision-log tool.
 * Decisions are stored as markdown files (or storage docs when no file
 * backend exists) – serializeDecision/parseDecision define that format and
 * MUST stay round-trip safe (see logic.test.ts).
 */

export type Decision = {
  title: string;
  /** Local calendar date, yyyy-mm-dd. */
  date: string;
  context: string;
  options: string;
  decision: string;
  rationale: string;
};

export type DecisionSection = Exclude<keyof Decision, 'title' | 'date'>;

/** Section order inside the markdown document. */
export const SECTION_ORDER: DecisionSection[] = ['context', 'options', 'decision', 'rationale'];

const HEADINGS: Record<'de' | 'en', Record<DecisionSection, string>> = {
  de: { context: 'Kontext', options: 'Optionen', decision: 'Entscheidung', rationale: 'Begründung' },
  en: { context: 'Context', options: 'Options', decision: 'Decision', rationale: 'Rationale' },
};

/** Both language variants are recognized when parsing (case-insensitive). */
const SECTION_BY_HEADING = new Map<string, DecisionSection>(
  (Object.keys(HEADINGS) as Array<'de' | 'en'>).flatMap((lang) =>
    SECTION_ORDER.map((section): [string, DecisionSection] => [
      HEADINGS[lang][section].toLowerCase(),
      section,
    ]),
  ),
);

/** Local date as yyyy-mm-dd (matches the todo tool's todayIso). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * File-name slug: lowercase, umlauts transliterated, everything else
 * non-alphanumeric collapsed to single dashes. Never empty, length-capped.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'decision';
}

/** "decision-YYYY-MM-DD-<slug>.md" – the canonical file name of a decision. */
export function decisionFileName(date: string, title: string): string {
  return `decision-${date}-${slugify(title)}.md`;
}

export function isDecisionFileName(name: string): boolean {
  return /^decision-\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(name);
}

/**
 * Markdown document: "# Title", the date as "*yyyy-mm-dd*", then one
 * "## Heading" block per non-empty section (headings in the given language;
 * parseDecision accepts both languages).
 */
export function serializeDecision(decision: Decision, language: string): string {
  const lang: 'de' | 'en' = language === 'de' ? 'de' : 'en';
  const blocks: string[] = [
    `# ${decision.title.replace(/\s*\n\s*/g, ' ').trim()}`,
    `*${decision.date}*`,
  ];
  for (const section of SECTION_ORDER) {
    const body = decision[section].replace(/\r\n/g, '\n').trim();
    if (!body) continue;
    blocks.push(`## ${HEADINGS[lang][section]}\n\n${body}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Parse a decision document written by serializeDecision (either language).
 * Returns null when no "# Title" line exists. Unknown "## …" headings start
 * an ignored section, so foreign markdown never bleeds into known fields.
 */
export function parseDecision(markdown: string): Decision | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title: string | null = null;
  let date = '';
  const sections: Record<DecisionSection, string[]> = {
    context: [],
    options: [],
    decision: [],
    rationale: [],
  };
  let current: DecisionSection | 'ignored' | null = null;

  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1 && title === null) {
      title = (h1[1] ?? '').trim();
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      current = SECTION_BY_HEADING.get((h2[1] ?? '').trim().toLowerCase()) ?? 'ignored';
      continue;
    }
    const dateLine = /^\*(\d{4}-\d{2}-\d{2})\*$/.exec(line.trim());
    if (dateLine && current === null && !date) {
      date = dateLine[1] ?? '';
      continue;
    }
    if (current && current !== 'ignored') sections[current].push(line);
  }

  if (title === null || !title) return null;
  const body = (section: DecisionSection): string => sections[section].join('\n').trim();
  return {
    title,
    date,
    context: body('context'),
    options: body('options'),
    decision: body('decision'),
    rationale: body('rationale'),
  };
}

/**
 * Assistant "current state" context: the last 5 decisions (newest first)
 * with their dates, so the assistant can reference instead of re-log them.
 */
export function buildDecisionContext(
  decisions: Array<Pick<Decision, 'title' | 'date'>>,
  language: string,
): string {
  const de = language === 'de';
  if (decisions.length === 0) {
    return de ? 'Noch keine Entscheidungen dokumentiert.' : 'No decisions logged yet.';
  }
  const latest = sortByDateDesc(decisions)
    .slice(0, 5)
    .map((d) => `«${d.title}» (${d.date})`);
  const label = de ? 'Letzte Entscheidungen' : 'Latest decisions';
  return `${label}: ${latest.join(', ')}.`;
}

/** Newest first; date ties broken by title for a stable order. */
export function sortByDateDesc<T extends Pick<Decision, 'title' | 'date'>>(decisions: T[]): T[] {
  return [...decisions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

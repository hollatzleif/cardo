/**
 * Card browser: an Anki-style search over cards + their notes, plus bulk
 * actions. Pure and framework-free so it unit-tests in plain node.
 *
 * Query syntax (space-separated terms are AND-ed; a leading "-" negates):
 *   deck:Name          card is in that deck or one of its subdecks
 *   tag:foo  tag:foo*   note has that tag (trailing * = prefix match)
 *   is:new|review|learn|due|suspended|buried
 *   flag:1 … flag:7     card flag colour
 *   added:7             card created within the last 7 days
 *   "two words"         phrase search across the note's fields
 *   plain               word search across the note's fields
 */

import { isSubdeckOf, type CardDoc, type NoteDoc } from './model';

/* ── Query parsing ────────────────────────────────────────────────────────── */

export type Term =
  | { kind: 'deck'; value: string; neg: boolean }
  | { kind: 'tag'; value: string; neg: boolean }
  | { kind: 'is'; value: string; neg: boolean }
  | { kind: 'flag'; value: number; neg: boolean }
  | { kind: 'added'; days: number; neg: boolean }
  | { kind: 'text'; value: string; neg: boolean };

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseQuery(query: string): Term[] {
  const raw = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const terms: Term[] = [];
  for (let token of raw) {
    const neg = token.startsWith('-');
    if (neg) token = token.slice(1);
    if (!token) continue;

    const colon = token.indexOf(':');
    const key = colon > 0 && !token.startsWith('"') ? token.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 && key ? stripQuotes(token.slice(colon + 1)) : '';

    switch (key) {
      case 'deck':
        terms.push({ kind: 'deck', value, neg });
        break;
      case 'tag':
        terms.push({ kind: 'tag', value, neg });
        break;
      case 'is':
        terms.push({ kind: 'is', value: value.toLowerCase(), neg });
        break;
      case 'flag':
        terms.push({ kind: 'flag', value: Number(value) || 0, neg });
        break;
      case 'added':
        terms.push({ kind: 'added', days: Math.max(0, Number(value) || 0), neg });
        break;
      default:
        terms.push({ kind: 'text', value: stripQuotes(token).toLowerCase(), neg });
    }
  }
  return terms;
}

/* ── Evaluation ───────────────────────────────────────────────────────────── */

export interface BrowseContext {
  today: string;
  nowIso: string;
  deckNameById: Map<string, string>;
  noteById: Map<string, NoteDoc>;
}

function addDays(dayKey: string, days: number): string {
  const ms = new Date(`${dayKey}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function noteText(note: NoteDoc | undefined): string {
  if (!note) return '';
  return stripHtml(Object.values(note.fields).join(' '));
}

function isDue(card: CardDoc, ctx: BrowseContext): boolean {
  if (card.suspended || card.buried) return false;
  if (card.state.phase === 'review') return card.due <= ctx.today;
  if (card.state.phase === 'learning' || card.state.phase === 'relearning') {
    return card.dueAt === null || card.dueAt <= ctx.nowIso;
  }
  return false; // new cards are not "due" in Anki's is:due sense
}

function tagMatches(tags: string[], value: string): boolean {
  const v = value.toLowerCase();
  if (v.endsWith('*')) {
    const prefix = v.slice(0, -1);
    return tags.some((t) => t.toLowerCase().startsWith(prefix));
  }
  return tags.some((t) => t.toLowerCase() === v);
}

function evalTerm(term: Term, card: CardDoc, ctx: BrowseContext): boolean {
  const note = ctx.noteById.get(card.noteId);
  switch (term.kind) {
    case 'deck': {
      const name = ctx.deckNameById.get(card.deckId) ?? '';
      return isSubdeckOf(name.toLowerCase(), term.value.toLowerCase());
    }
    case 'tag':
      return tagMatches(note?.tags ?? [], term.value);
    case 'flag':
      return card.flag === term.value;
    case 'added':
      return card.createdAt.slice(0, 10) >= addDays(ctx.today, -term.days);
    case 'is':
      switch (term.value) {
        case 'due':
          return isDue(card, ctx);
        case 'new':
          return card.state.phase === 'new';
        case 'review':
          return card.state.phase === 'review';
        case 'learn':
        case 'learning':
          return card.state.phase === 'learning' || card.state.phase === 'relearning';
        case 'suspended':
          return card.suspended;
        case 'buried':
          return card.buried;
        default:
          return false;
      }
    case 'text':
      return term.value === '' || noteText(note).includes(term.value);
    default:
      return false;
  }
}

/** True if the card matches every term (negation handled per term). */
export function matchesQuery(card: CardDoc, ctx: BrowseContext, terms: Term[]): boolean {
  return terms.every((term) => {
    const hit = evalTerm(term, card, ctx);
    return term.neg ? !hit : hit;
  });
}

/** Cards matching the query string, in the given order (stable). */
export function filterCards(cards: CardDoc[], ctx: BrowseContext, query: string): CardDoc[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return cards;
  return cards.filter((card) => matchesQuery(card, ctx, terms));
}

/* ── Bulk actions (return the changed docs to persist) ────────────────────── */

function pick<T extends { id: string }>(items: T[], ids: Set<string>): T[] {
  return items.filter((it) => ids.has(it.id));
}

export function setSuspended(cards: CardDoc[], ids: Set<string>, suspended: boolean): CardDoc[] {
  return pick(cards, ids).map((c) => ({ ...c, suspended }));
}

export function setBuried(cards: CardDoc[], ids: Set<string>, buried: boolean): CardDoc[] {
  return pick(cards, ids).map((c) => ({ ...c, buried }));
}

export function setFlag(cards: CardDoc[], ids: Set<string>, flag: CardDoc['flag']): CardDoc[] {
  return pick(cards, ids).map((c) => ({ ...c, flag }));
}

export function moveToDeck(cards: CardDoc[], ids: Set<string>, deckId: string): CardDoc[] {
  return pick(cards, ids).map((c) => ({ ...c, deckId }));
}

export function addTag(notes: NoteDoc[], ids: Set<string>, tag: string): NoteDoc[] {
  const t = tag.trim();
  if (!t) return [];
  return pick(notes, ids)
    .filter((n) => !n.tags.includes(t))
    .map((n) => ({ ...n, tags: [...n.tags, t] }));
}

export function removeTag(notes: NoteDoc[], ids: Set<string>, tag: string): NoteDoc[] {
  const t = tag.trim();
  return pick(notes, ids)
    .filter((n) => n.tags.includes(t))
    .map((n) => ({ ...n, tags: n.tags.filter((x) => x !== t) }));
}

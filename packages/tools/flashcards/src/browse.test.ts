import { describe, it, expect } from 'vitest';
import { newCardState, type CardDoc, type CardState, type NoteDoc } from './model';
import {
  addTag,
  filterCards,
  moveToDeck,
  parseQuery,
  removeTag,
  setFlag,
  setSuspended,
  type BrowseContext,
} from './browse';

function card(id: string, over: Omit<Partial<CardDoc>, 'state'> & { state?: Partial<CardState> } = {}): CardDoc {
  return {
    id,
    type: 'card',
    noteId: over.noteId ?? `note-${id}`,
    templateIndex: 0,
    deckId: over.deckId ?? 'deck:spanish',
    state: { ...newCardState(), ...(over.state ?? {}) },
    due: over.due ?? '2026-07-17',
    dueAt: over.dueAt ?? null,
    suspended: over.suspended ?? false,
    buried: over.buried ?? false,
    flag: over.flag ?? 0,
    createdAt: over.createdAt ?? '2026-07-10T00:00:00.000Z',
  };
}

function note(id: string, fields: Record<string, string>, tags: string[] = []): NoteDoc {
  return { id, type: 'note', noteTypeId: 'nt', fields, tags, createdAt: '2026-07-10T00:00:00.000Z' };
}

const ctx: BrowseContext = {
  today: '2026-07-17',
  nowIso: '2026-07-17T09:00:00.000Z',
  deckNameById: new Map([
    ['deck:spanish', 'Spanisch'],
    ['deck:spanish-verbs', 'Spanisch::Verben'],
    ['deck:math', 'Mathe'],
  ]),
  noteById: new Map([
    ['n1', note('n1', { Front: 'hola', Back: 'hallo' }, ['vocab', 'greeting'])],
    ['n2', note('n2', { Front: 'adiós', Back: '<b>tschüss</b>' }, ['vocab'])],
  ]),
};

describe('parseQuery', () => {
  it('parses keyed terms, negation and quotes', () => {
    const terms = parseQuery('deck:Spanisch -tag:vocab is:due "two words" hello');
    expect(terms).toEqual([
      { kind: 'deck', value: 'Spanisch', neg: false },
      { kind: 'tag', value: 'vocab', neg: true },
      { kind: 'is', value: 'due', neg: false },
      { kind: 'text', value: 'two words', neg: false },
      { kind: 'text', value: 'hello', neg: false },
    ]);
  });

  it('keeps quoted deck names together', () => {
    expect(parseQuery('deck:"My Deck"')).toEqual([{ kind: 'deck', value: 'My Deck', neg: false }]);
  });
});

describe('filterCards', () => {
  it('empty query returns everything', () => {
    const cards = [card('1'), card('2')];
    expect(filterCards(cards, ctx, '   ')).toHaveLength(2);
  });

  it('deck: matches the deck and its subdecks', () => {
    const cards = [card('1', { deckId: 'deck:spanish' }), card('2', { deckId: 'deck:spanish-verbs' }), card('3', { deckId: 'deck:math' })];
    expect(filterCards(cards, ctx, 'deck:Spanisch').map((c) => c.id)).toEqual(['1', '2']);
    expect(filterCards(cards, ctx, 'deck:Mathe').map((c) => c.id)).toEqual(['3']);
  });

  it('tag: exact and wildcard, with negation', () => {
    const cards = [card('1', { noteId: 'n1' }), card('2', { noteId: 'n2' })];
    expect(filterCards(cards, ctx, 'tag:greeting').map((c) => c.id)).toEqual(['1']);
    expect(filterCards(cards, ctx, 'tag:gree*').map((c) => c.id)).toEqual(['1']);
    expect(filterCards(cards, ctx, '-tag:greeting').map((c) => c.id)).toEqual(['2']);
  });

  it('is:due / is:new / is:suspended', () => {
    const cards = [
      card('due', { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-16' }),
      card('future', { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-20' }),
      card('new', { state: { phase: 'new' } }),
      card('susp', { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-16', suspended: true }),
    ];
    expect(filterCards(cards, ctx, 'is:due').map((c) => c.id)).toEqual(['due']);
    expect(filterCards(cards, ctx, 'is:new').map((c) => c.id)).toEqual(['new']);
    expect(filterCards(cards, ctx, 'is:suspended').map((c) => c.id)).toEqual(['susp']);
  });

  it('flag: and added:', () => {
    const cards = [
      card('flagged', { flag: 2 }),
      card('recent', { createdAt: '2026-07-16T00:00:00.000Z' }),
      card('old', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(filterCards(cards, ctx, 'flag:2').map((c) => c.id)).toEqual(['flagged']);
    // Only "recent" (07-16) is within 3 days of today; "flagged"/"old" are older.
    expect(filterCards(cards, ctx, 'added:3').map((c) => c.id)).toEqual(['recent']);
  });

  it('text search runs over note fields, HTML stripped, and ANDs terms', () => {
    const cards = [card('1', { noteId: 'n1' }), card('2', { noteId: 'n2' })];
    expect(filterCards(cards, ctx, 'hola').map((c) => c.id)).toEqual(['1']);
    expect(filterCards(cards, ctx, 'tschüss').map((c) => c.id)).toEqual(['2']); // inside <b>
    // "vocab" is a tag, not a field word, so the AND with "hola" matches nothing.
    expect(filterCards(cards, ctx, 'vocab hola').map((c) => c.id)).toEqual([]);
  });
});

describe('bulk actions', () => {
  const cards = [card('1'), card('2'), card('3')];
  const ids = new Set(['1', '3']);

  it('suspend/flag/move only touch the selected cards', () => {
    expect(setSuspended(cards, ids, true).map((c) => c.id)).toEqual(['1', '3']);
    expect(setSuspended(cards, ids, true).every((c) => c.suspended)).toBe(true);
    expect(setFlag(cards, ids, 3).every((c) => c.flag === 3)).toBe(true);
    expect(moveToDeck(cards, ids, 'deck:math').every((c) => c.deckId === 'deck:math')).toBe(true);
  });

  it('addTag skips notes that already have it; removeTag only touches those that do', () => {
    const notes = [note('n1', {}, ['a']), note('n2', {}, [])];
    const all = new Set(['n1', 'n2']);
    const added = addTag(notes, all, 'a');
    expect(added.map((n) => n.id)).toEqual(['n2']); // n1 already had it
    expect(added[0]!.tags).toEqual(['a']);

    const removed = removeTag(notes, all, 'a');
    expect(removed.map((n) => n.id)).toEqual(['n1']);
    expect(removed[0]!.tags).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  basicNoteType,
  defaultDeckOptions,
  deckLeaf,
  deckParent,
  deckParts,
  isSubdeckOf,
  makeCard,
  makeNote,
  migrateFlatCards,
  newCardState,
  stateFromOldCard,
  type OldCardDoc,
  type OldDeckDoc,
} from './model';

describe('scheduling state', () => {
  it('a fresh state is new and empty', () => {
    const s = newCardState();
    expect(s.phase).toBe('new');
    expect(s.intervalDays).toBe(0);
    expect(s.stability).toBe(0);
    expect(s.difficulty).toBe(0);
  });

  it('mirrors the Rust serde field names (camelCase)', () => {
    // These keys must match cardo-core::srs::CardState exactly so a card can
    // round-trip through the Rust scheduler command untranslated.
    expect(Object.keys(newCardState()).sort()).toEqual(
      ['difficulty', 'ease', 'intervalDays', 'lapses', 'phase', 'reps', 'stability', 'step'].sort(),
    );
  });
});

describe('factories', () => {
  it('basic note type has two fields and one template', () => {
    const nt = basicNoteType();
    expect(nt.fields).toEqual(['Vorderseite', 'Rückseite']);
    expect(nt.templates).toHaveLength(1);
    expect(nt.templates[0]!.front).toContain('{{Vorderseite}}');
  });

  it('default options use FSRS at 0.9 retention', () => {
    const o = defaultDeckOptions();
    expect(o.scheduler).toBe('fsrs');
    expect(o.desiredRetention).toBe(0.9);
    expect(o.learningStepsMin).toEqual([1, 10]);
  });

  it('note trims + dedupes tags', () => {
    const n = makeNote('nt1', { a: '1' }, [' math ', 'math', '']);
    expect(n.tags).toEqual(['math']);
  });

  it('a fresh card is due today and unsuspended', () => {
    const c = makeCard({ noteId: 'n1', templateIndex: 0, deckId: 'd1' }, '2026-07-17');
    expect(c.due).toBe('2026-07-17');
    expect(c.suspended).toBe(false);
    expect(c.state.phase).toBe('new');
    expect(c.dueAt).toBeNull();
  });
});

describe('deck hierarchy', () => {
  it('splits and resolves parent/leaf', () => {
    expect(deckParts('A::B::C')).toEqual(['A', 'B', 'C']);
    expect(deckParent('A::B::C')).toBe('A::B');
    expect(deckParent('Top')).toBeNull();
    expect(deckLeaf('A::B::C')).toBe('C');
  });

  it('subdeck test matches self and descendants only', () => {
    expect(isSubdeckOf('A', 'A')).toBe(true);
    expect(isSubdeckOf('A::B', 'A')).toBe(true);
    expect(isSubdeckOf('A::B::C', 'A')).toBe(true);
    expect(isSubdeckOf('AB', 'A')).toBe(false); // not a real subdeck
    expect(isSubdeckOf('B', 'A')).toBe(false);
  });
});

describe('migration from the flat model', () => {
  const oldDecks: OldDeckDoc[] = [
    { id: 'deck:1', type: 'deck', name: 'Spanisch', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const oldCards: OldCardDoc[] = [
    {
      id: 'card:1',
      type: 'card',
      deckId: 'deck:1',
      front: 'hola',
      back: 'hallo',
      ease: 2.6,
      intervalDays: 12,
      due: '2026-07-20',
      reps: 3,
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'card:2',
      type: 'card',
      deckId: 'deck:1',
      front: 'adiós',
      back: 'tschüss',
      ease: 2.5,
      intervalDays: 0,
      due: '2026-07-17',
      reps: 0,
      createdAt: '2026-01-03T00:00:00.000Z',
    },
  ];

  it('produces one note type, one options preset, decks/notes/cards', () => {
    const r = migrateFlatCards(oldDecks, oldCards);
    expect(r.noteType.name).toBe('Einfach');
    expect(r.options.scheduler).toBe('fsrs');
    expect(r.decks).toHaveLength(1);
    expect(r.notes).toHaveLength(2);
    expect(r.cards).toHaveLength(2);
    expect(r.decks[0]!.optionsId).toBe(r.options.id);
  });

  it('keeps deck + card ids and due dates stable', () => {
    const r = migrateFlatCards(oldDecks, oldCards);
    expect(r.decks[0]!.id).toBe('deck:1');
    const card1 = r.cards.find((c) => c.id === 'card:1')!;
    expect(card1.due).toBe('2026-07-20');
    expect(card1.deckId).toBe('deck:1');
  });

  it('carries front/back into note fields and preserves SM-2 progress', () => {
    const r = migrateFlatCards(oldDecks, oldCards);
    const card1 = r.cards.find((c) => c.id === 'card:1')!;
    const note1 = r.notes.find((n) => n.id === card1.noteId)!;
    expect(note1.fields).toEqual({ Vorderseite: 'hola', Rückseite: 'hallo' });
    expect(card1.state.phase).toBe('review'); // interval > 0
    expect(card1.state.ease).toBe(2.6);
    expect(card1.state.intervalDays).toBe(12);
    expect(card1.state.reps).toBe(3);
  });

  it('a never-reviewed old card migrates as new', () => {
    const r = migrateFlatCards(oldDecks, oldCards);
    const card2 = r.cards.find((c) => c.id === 'card:2')!;
    expect(card2.state.phase).toBe('new');
    expect(stateFromOldCard(oldCards[1]!).phase).toBe('new');
  });

  it('every card links to a real note and deck', () => {
    const r = migrateFlatCards(oldDecks, oldCards);
    const noteIds = new Set(r.notes.map((n) => n.id));
    const deckIds = new Set(r.decks.map((d) => d.id));
    for (const card of r.cards) {
      expect(noteIds.has(card.noteId)).toBe(true);
      expect(deckIds.has(card.deckId)).toBe(true);
    }
  });
});

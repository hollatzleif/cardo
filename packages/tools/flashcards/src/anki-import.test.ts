import { describe, it, expect } from 'vitest';
import type { AnkiCollection } from '@cardo/plugin-api';
import { ankiCollectionToDocs } from './anki-import';

const COLL: AnkiCollection = {
  noteTypes: [
    { id: '1000', name: 'Basic', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }], css: '.card{}', cloze: false },
  ],
  decks: [{ id: '2000', name: 'Spanish' }],
  notes: [
    { id: '3000', noteTypeId: '1000', fields: ['hola', 'hallo'], tags: ['vocab'] },
  ],
  cards: [
    { id: '4000', noteId: '3000', ord: 0, deckId: '2000', phase: 'review', intervalDays: 12, ease: 2.6, reps: 3, lapses: 1 },
    { id: '4001', noteId: 'orphan', ord: 0, deckId: '2000', phase: 'new', intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 },
    { id: '4002', noteId: '3000', ord: 0, deckId: 'unknown-deck', phase: 'new', intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 },
  ],
  media: [{ name: 'cat.jpg', dataBase64: 'aGVsbG8=' }],
};

describe('ankiCollectionToDocs', () => {
  it('maps note types, notes (field names) and preserves scheduling', () => {
    const docs = ankiCollectionToDocs(COLL, 'opt-1', '2026-07-17');
    expect(docs.noteTypes).toHaveLength(1);
    expect(docs.noteTypes[0]!.templates[0]!.front).toBe('{{Front}}');

    expect(docs.notes).toHaveLength(1);
    expect(docs.notes[0]!.fields).toEqual({ Front: 'hola', Back: 'hallo' });
    expect(docs.notes[0]!.noteTypeId).toBe(docs.noteTypes[0]!.id);

    const reviewed = docs.cards.find((c) => c.state.intervalDays === 12)!;
    expect(reviewed.state.phase).toBe('review');
    expect(reviewed.state.ease).toBe(2.6);
    expect(reviewed.state.reps).toBe(3);
    expect(reviewed.state.lapses).toBe(1);
  });

  it('skips orphan cards and routes unknown decks to an import deck', () => {
    const docs = ankiCollectionToDocs(COLL, 'opt-1', '2026-07-17');
    // 3 input cards: one orphan (no note) dropped → 2 cards.
    expect(docs.cards).toHaveLength(2);
    // The card with an unknown deck goes to a fallback "Anki-Import" deck.
    expect(docs.decks.some((d) => d.name === 'Anki-Import')).toBe(true);
    for (const card of docs.cards) {
      expect(docs.notes.some((n) => n.id === card.noteId)).toBe(true);
      expect(docs.decks.some((d) => d.id === card.deckId)).toBe(true);
    }
  });

  it('every deck references the given options preset', () => {
    const docs = ankiCollectionToDocs(COLL, 'opt-1', '2026-07-17');
    expect(docs.decks.every((d) => d.optionsId === 'opt-1')).toBe(true);
  });

  it('imports media with mime + size', () => {
    const docs = ankiCollectionToDocs(COLL, 'opt-1', '2026-07-17');
    expect(docs.media).toHaveLength(1);
    expect(docs.media[0]!.mime).toBe('image/jpeg');
    expect(docs.media[0]!.size).toBe(5);
  });
});

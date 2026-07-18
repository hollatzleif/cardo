/**
 * Convert an imported Anki collection (from the host's `.apkg` parser) into
 * Cardo's own model documents. Pure and unit-testable; ids are freshly minted
 * and remapped consistently so notes/cards keep pointing at the right note type
 * and deck.
 */

import type { AnkiCollection } from '@cardo/plugin-api';
import {
  makeId,
  newCardState,
  type CardDoc,
  type DeckDoc,
  type NoteDoc,
  type NoteTypeDoc,
} from './model';
import { makeMediaDoc, type MediaDoc } from './media';

export interface ImportedDocs {
  noteTypes: NoteTypeDoc[];
  decks: DeckDoc[];
  notes: NoteDoc[];
  cards: CardDoc[];
  media: MediaDoc[];
}

const KNOWN_PHASES = new Set(['new', 'learning', 'review', 'relearning']);

/** Reverse map: Cardo model documents → an Anki collection for export. */
export function docsToAnkiCollection(coll: {
  noteTypes: NoteTypeDoc[];
  decks: DeckDoc[];
  notes: NoteDoc[];
  cards: CardDoc[];
  media: MediaDoc[];
}): AnkiCollection {
  const fieldsOf = new Map(coll.noteTypes.map((nt) => [nt.id, nt.fields]));
  return {
    noteTypes: coll.noteTypes.map((nt) => ({
      id: nt.id,
      name: nt.name,
      fields: nt.fields,
      templates: nt.templates.map((t) => ({ name: t.name, qfmt: t.front, afmt: t.back })),
      css: nt.css,
      cloze: nt.cloze,
    })),
    decks: coll.decks.map((d) => ({ id: d.id, name: d.name })),
    notes: coll.notes.map((n) => ({
      id: n.id,
      noteTypeId: n.noteTypeId,
      fields: (fieldsOf.get(n.noteTypeId) ?? Object.keys(n.fields)).map((f) => n.fields[f] ?? ''),
      tags: n.tags,
    })),
    cards: coll.cards.map((c) => ({
      id: c.id,
      noteId: c.noteId,
      ord: c.templateIndex,
      deckId: c.deckId,
      phase: c.state.phase,
      intervalDays: c.state.intervalDays,
      ease: c.state.ease,
      reps: c.state.reps,
      lapses: c.state.lapses,
    })),
    media: coll.media.map((m) => ({ name: m.name, dataBase64: m.data })),
  };
}

export function ankiCollectionToDocs(
  coll: AnkiCollection,
  optionsId: string,
  today: string,
  now: Date = new Date(),
): ImportedDocs {
  const iso = now.toISOString();

  // Note types → keep their field names for positional note mapping.
  const noteTypes: NoteTypeDoc[] = [];
  const ntIdMap = new Map<string, string>();
  const ntFields = new Map<string, string[]>();
  for (const nt of coll.noteTypes) {
    const id = makeId('noteType');
    ntIdMap.set(nt.id, id);
    const fields = nt.fields.length > 0 ? nt.fields : ['Vorderseite', 'Rückseite'];
    ntFields.set(nt.id, fields);
    noteTypes.push({
      id,
      type: 'noteType',
      name: nt.name || 'Anki',
      fields,
      templates:
        nt.templates.length > 0
          ? nt.templates.map((t) => ({ name: t.name || 'Karte', front: t.qfmt, back: t.afmt }))
          : [{ name: 'Karte 1', front: `{{${fields[0]}}}`, back: `{{${fields[1] ?? fields[0]}}}` }],
      cloze: nt.cloze,
      css: nt.css,
      createdAt: iso,
    });
  }
  const fallbackNt = noteTypes[0];

  // Decks (+ a fallback for cards that reference an unknown/default deck).
  const decks: DeckDoc[] = [];
  const deckIdMap = new Map<string, string>();
  for (const d of coll.decks) {
    const id = makeId('deck');
    deckIdMap.set(d.id, id);
    decks.push({ id, type: 'deck', name: d.name || 'Anki', optionsId, createdAt: iso });
  }
  const ensureDeck = (ankiDeckId: string): string => {
    const mapped = deckIdMap.get(ankiDeckId);
    if (mapped) return mapped;
    const existing = decks.find((d) => d.name === 'Anki-Import');
    if (existing) {
      deckIdMap.set(ankiDeckId, existing.id);
      return existing.id;
    }
    const id = makeId('deck');
    deckIdMap.set(ankiDeckId, id);
    decks.push({ id, type: 'deck', name: 'Anki-Import', optionsId, createdAt: iso });
    return id;
  };

  // Notes → field values keyed by their note type's field names.
  const notes: NoteDoc[] = [];
  const noteIdMap = new Map<string, string>();
  for (const n of coll.notes) {
    const id = makeId('note');
    noteIdMap.set(n.id, id);
    const noteTypeId = ntIdMap.get(n.noteTypeId) ?? fallbackNt?.id ?? '';
    const fieldNames = ntFields.get(n.noteTypeId) ?? fallbackNt?.fields ?? [];
    const fields: Record<string, string> = {};
    fieldNames.forEach((name, i) => {
      fields[name] = n.fields[i] ?? '';
    });
    notes.push({ id, type: 'note', noteTypeId, fields, tags: n.tags, createdAt: iso });
  }

  // Cards → Cardo scheduling state; due now so they enter today's queue.
  const cards: CardDoc[] = [];
  for (const c of coll.cards) {
    const noteId = noteIdMap.get(c.noteId);
    if (!noteId) continue; // orphan card without a note – skip
    const phase = KNOWN_PHASES.has(c.phase) ? (c.phase as CardDoc['state']['phase']) : 'review';
    cards.push({
      id: makeId('card'),
      type: 'card',
      noteId,
      templateIndex: Math.max(0, c.ord),
      deckId: ensureDeck(c.deckId),
      state: {
        ...newCardState(),
        phase,
        ease: c.ease > 0 ? c.ease : 2.5,
        intervalDays: Math.max(0, c.intervalDays),
        reps: Math.max(0, c.reps),
        lapses: Math.max(0, c.lapses),
      },
      due: today,
      dueAt: null,
      suspended: false,
      buried: false,
      flag: 0,
      createdAt: iso,
    });
  }

  const media: MediaDoc[] = coll.media
    .filter((m) => m.name && m.dataBase64)
    .map((m) => {
      try {
        return makeMediaDoc(m.name, m.dataBase64, now);
      } catch {
        return null;
      }
    })
    .filter((m): m is MediaDoc => m !== null);

  return { noteTypes, decks, notes, cards, media };
}

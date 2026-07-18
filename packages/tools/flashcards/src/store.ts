/**
 * Storage integration + migration for the flashcards tool. Loads/saves the
 * Anki-class model documents through the host's ToolStorage and migrates the
 * old flat card model (≤ v1.0) into the new one exactly once.
 */

import type { ToolStorage } from '@cardo/plugin-api';
import {
  basicNoteType,
  defaultDeckOptions,
  migrateFlatCards,
  type CardDoc,
  type DeckDoc,
  type DeckOptionsDoc,
  type NoteDoc,
  type NoteTypeDoc,
  type OldCardDoc,
  type OldDeckDoc,
} from './model';
import type { MediaDoc } from './media';
import type { AnkiCollection } from '@cardo/plugin-api';
import { ankiCollectionToDocs } from './anki-import';

export interface Collection {
  noteTypes: NoteTypeDoc[];
  notes: NoteDoc[];
  cards: CardDoc[];
  decks: DeckDoc[];
  options: DeckOptionsDoc[];
  media: MediaDoc[];
}

/** Persist an imported Anki collection, returning a summary of what came in. */
export async function importAnkiCollection(
  storage: ToolStorage,
  coll: AnkiCollection,
  today: string,
): Promise<{ decks: number; notes: number; cards: number; media: number }> {
  const { options } = await ensureDefaults(storage);
  const docs = ankiCollectionToDocs(coll, options.id, today);
  for (const nt of docs.noteTypes) await storage.set(nt.id, nt);
  for (const d of docs.decks) await storage.set(d.id, d);
  for (const n of docs.notes) await storage.set(n.id, n);
  for (const c of docs.cards) await storage.set(c.id, c);
  for (const m of docs.media) await storage.set(m.id, m);
  return {
    decks: docs.decks.length,
    notes: docs.notes.length,
    cards: docs.cards.length,
    media: docs.media.length,
  };
}

export const MODEL_VERSION = 2;
const META_ID = 'meta:model';

type MetaDoc = {
  id: string;
  type: 'meta';
  version: number;
};

async function byType<T>(storage: ToolStorage, type: string): Promise<T[]> {
  return storage.query<T>({ where: [{ field: 'type', op: '=', value: type }] });
}

export async function loadCollection(storage: ToolStorage): Promise<Collection> {
  const [noteTypes, notes, cards, decks, options, media] = await Promise.all([
    byType<NoteTypeDoc>(storage, 'noteType'),
    byType<NoteDoc>(storage, 'note'),
    byType<CardDoc>(storage, 'card'),
    byType<DeckDoc>(storage, 'deck'),
    byType<DeckOptionsDoc>(storage, 'deckOptions'),
    byType<MediaDoc>(storage, 'media'),
  ]);
  return { noteTypes, notes, cards, decks, options, media };
}

/** Ensure at least a "Basic" note type and a default options preset exist. */
export async function ensureDefaults(
  storage: ToolStorage,
): Promise<{ noteType: NoteTypeDoc; options: DeckOptionsDoc }> {
  const existingTypes = await byType<NoteTypeDoc>(storage, 'noteType');
  let noteType = existingTypes[0];
  if (!noteType) {
    noteType = basicNoteType();
    await storage.set(noteType.id, noteType);
  }
  const existingOptions = await byType<DeckOptionsDoc>(storage, 'deckOptions');
  let options = existingOptions[0];
  if (!options) {
    options = defaultDeckOptions();
    await storage.set(options.id, options);
  }
  return { noteType, options };
}

/**
 * Run the flat→Anki-class migration once. Old cards (front/back, no noteId)
 * and old decks (no optionsId) are converted in place – ids and due dates are
 * preserved. Idempotent: a model-version marker guards re-runs.
 */
export async function migrateIfNeeded(
  storage: ToolStorage,
): Promise<{ migrated: boolean; cards: number }> {
  const meta = await storage.get<MetaDoc>(META_ID);
  if (meta && meta.version >= MODEL_VERSION) return { migrated: false, cards: 0 };

  const allCards = await byType<Record<string, unknown>>(storage, 'card');
  const allDecks = await byType<Record<string, unknown>>(storage, 'deck');
  const oldCards = allCards.filter((c) => 'front' in c && !('noteId' in c)) as unknown as OldCardDoc[];
  const oldDecks = allDecks.filter((d) => !('optionsId' in d)) as unknown as OldDeckDoc[];

  let migratedCards = 0;
  if (oldCards.length > 0 || oldDecks.length > 0) {
    const r = migrateFlatCards(oldDecks, oldCards);
    await storage.set(r.noteType.id, r.noteType);
    await storage.set(r.options.id, r.options);
    for (const d of r.decks) await storage.set(d.id, d);
    for (const n of r.notes) await storage.set(n.id, n);
    for (const c of r.cards) await storage.set(c.id, c);
    migratedCards = r.cards.length;
  } else {
    await ensureDefaults(storage);
  }

  const marker: MetaDoc = { id: META_ID, type: 'meta', version: MODEL_VERSION };
  await storage.set(META_ID, marker);
  return { migrated: migratedCards > 0, cards: migratedCards };
}

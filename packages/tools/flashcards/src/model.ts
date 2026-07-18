/**
 * Anki-class data model for the flashcards tool. Pure and storage-free so it
 * unit-tests in plain node. Documents carry a `type` discriminator and are
 * stored by id under the tool namespace (like the rest of Cardo).
 *
 * Scheduling state (`CardState`) mirrors the Rust `cardo-core::srs::CardState`
 * serde shape byte-for-byte, so a card round-trips through the Rust scheduler
 * command without translation. The pure model here never *computes* schedules
 * (that's the Rust core) – it only stores the state and organises notes,
 * cards, note types and decks.
 */

/* ── Scheduling state (mirror of Rust srs::CardState) ─────────────────────── */

export type Phase = 'new' | 'learning' | 'review' | 'relearning';

export interface CardState {
  phase: Phase;
  /** SM-2 ease factor (FSRS ignores it). */
  ease: number;
  /** Review interval in days (0 while new). */
  intervalDays: number;
  reps: number;
  lapses: number;
  /** Index into the active (re)learning step list. */
  step: number;
  /** FSRS memory stability in days (0 until FSRS touches it). */
  stability: number;
  /** FSRS difficulty 1–10 (0 until FSRS touches it). */
  difficulty: number;
}

export const DEFAULT_EASE = 2.5;

export function newCardState(): CardState {
  return {
    phase: 'new',
    ease: DEFAULT_EASE,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    step: 0,
    stability: 0,
    difficulty: 0,
  };
}

/* ── Documents ────────────────────────────────────────────────────────────── */

export interface CardTemplate {
  name: string;
  /** Front-side HTML template with {{Field}} / {{#Field}}…{{/Field}} / cloze. */
  front: string;
  /** Back-side template ({{FrontSide}} is available). */
  back: string;
}

export type NoteTypeDoc = {
  id: string;
  type: 'noteType';
  name: string;
  /** Ordered field names; note values are keyed by these. */
  fields: string[];
  /** One or more card templates (each note spawns one card per template). */
  templates: CardTemplate[];
  /** Whether the first field is a cloze field ("{{cloze:…}}" note type). */
  cloze: boolean;
  css: string;
  createdAt: string;
}

export type NoteDoc = {
  id: string;
  type: 'note';
  noteTypeId: string;
  /** Field values keyed by the note type's field names. */
  fields: Record<string, string>;
  tags: string[];
  createdAt: string;
}

/** Anki card flags: 0 = none, 1-7 = coloured flags. */
export type Flag = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type CardDoc = {
  id: string;
  type: 'card';
  noteId: string;
  /** Which of the note type's templates produced this card. */
  templateIndex: number;
  deckId: string;
  state: CardState;
  /** Review due: yyyy-mm-dd (day granularity). Sub-day steps use `dueAt`. */
  due: string;
  /** ISO datetime for sub-day (learning/relearning) scheduling; else null. */
  dueAt: string | null;
  suspended: boolean;
  buried: boolean;
  flag: Flag;
  createdAt: string;
}

export type DeckOptionsDoc = {
  id: string;
  type: 'deckOptions';
  name: string;
  scheduler: 'fsrs' | 'sm2';
  /** FSRS desired retention (0–1). */
  desiredRetention: number;
  newPerDay: number;
  reviewsPerDay: number;
  learningStepsMin: number[];
  relearningStepsMin: number[];
  graduatingIntervalDays: number;
  easyIntervalDays: number;
  startingEase: number;
}

export type DeckDoc = {
  id: string;
  type: 'deck';
  /** Hierarchical name, "Parent::Child::Leaf". */
  name: string;
  optionsId: string;
  createdAt: string;
}

/* ── Ids / factories ──────────────────────────────────────────────────────── */

export type DocPrefix = 'noteType' | 'note' | 'card' | 'deck' | 'deckOptions';

export function makeId(prefix: DocPrefix): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The built-in "Basic" (front/back) note type, localised name aside. */
export function basicNoteType(name = 'Einfach', now: Date = new Date()): NoteTypeDoc {
  return {
    id: makeId('noteType'),
    type: 'noteType',
    name,
    fields: ['Vorderseite', 'Rückseite'],
    templates: [
      {
        name: 'Karte 1',
        front: '{{Vorderseite}}',
        back: '{{FrontSide}}\n\n<hr id="answer">\n\n{{Rückseite}}',
      },
    ],
    cloze: false,
    css: '.card { font-size: 1.25rem; text-align: center; }',
    createdAt: now.toISOString(),
  };
}

/** Default deck options preset (FSRS, Anki defaults). */
export function defaultDeckOptions(name = 'Standard'): DeckOptionsDoc {
  return {
    id: makeId('deckOptions'),
    type: 'deckOptions',
    name,
    scheduler: 'fsrs',
    desiredRetention: 0.9,
    newPerDay: 20,
    reviewsPerDay: 200,
    learningStepsMin: [1, 10],
    relearningStepsMin: [10],
    graduatingIntervalDays: 1,
    easyIntervalDays: 4,
    startingEase: DEFAULT_EASE,
  };
}

export function makeDeck(name: string, optionsId: string, now: Date = new Date()): DeckDoc {
  return {
    id: makeId('deck'),
    type: 'deck',
    name: name.trim(),
    optionsId,
    createdAt: now.toISOString(),
  };
}

export function makeNote(
  noteTypeId: string,
  fields: Record<string, string>,
  tags: string[] = [],
  now: Date = new Date(),
): NoteDoc {
  return {
    id: makeId('note'),
    type: 'note',
    noteTypeId,
    fields,
    tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))],
    createdAt: now.toISOString(),
  };
}

/** A fresh card is due today (day granularity) with a brand-new state. */
export function makeCard(
  input: { noteId: string; templateIndex: number; deckId: string },
  today: string,
  now: Date = new Date(),
): CardDoc {
  return {
    id: makeId('card'),
    type: 'card',
    noteId: input.noteId,
    templateIndex: input.templateIndex,
    deckId: input.deckId,
    state: newCardState(),
    due: today,
    dueAt: null,
    suspended: false,
    buried: false,
    flag: 0,
    createdAt: now.toISOString(),
  };
}

/* ── Deck hierarchy helpers ("Parent::Child") ─────────────────────────────── */

export const DECK_SEP = '::';

export function deckParts(name: string): string[] {
  return name.split(DECK_SEP);
}

export function deckParent(name: string): string | null {
  const parts = deckParts(name);
  return parts.length > 1 ? parts.slice(0, -1).join(DECK_SEP) : null;
}

export function deckLeaf(name: string): string {
  const parts = deckParts(name);
  return parts[parts.length - 1] ?? name;
}

/** True if `name` is `ancestor` itself or one of its descendants. */
export function isSubdeckOf(name: string, ancestor: string): boolean {
  return name === ancestor || name.startsWith(ancestor + DECK_SEP);
}

/* ── Migration from the old flat card model ───────────────────────────────── */

/** The old (≤ v1.0) flat documents this tool used to store. */
export interface OldDeckDoc {
  id: string;
  type: 'deck';
  name: string;
  createdAt: string;
}
export interface OldCardDoc {
  id: string;
  type: 'card';
  deckId: string;
  front: string;
  back: string;
  ease: number;
  intervalDays: number;
  due: string;
  reps: number;
  createdAt: string;
}

export interface MigrationResult {
  noteType: NoteTypeDoc;
  options: DeckOptionsDoc;
  decks: DeckDoc[];
  notes: NoteDoc[];
  cards: CardDoc[];
}

/** Old SM-2 fields → the new scheduling state. */
export function stateFromOldCard(old: Pick<OldCardDoc, 'ease' | 'intervalDays' | 'reps'>): CardState {
  return {
    phase: old.intervalDays > 0 ? 'review' : 'new',
    ease: old.ease || DEFAULT_EASE,
    intervalDays: old.intervalDays,
    reps: old.reps,
    lapses: 0,
    step: 0,
    stability: 0,
    difficulty: 0,
  };
}

/**
 * Convert the whole flat collection into the new model: one shared "Basic"
 * note type + one default options preset; every old deck keeps its id/name,
 * every old card becomes a note (Vorderseite/Rückseite) plus one card that
 * preserves its due date and SM-2 progress.
 */
export function migrateFlatCards(
  oldDecks: OldDeckDoc[],
  oldCards: OldCardDoc[],
  now: Date = new Date(),
): MigrationResult {
  const noteType = basicNoteType('Einfach', now);
  const options = defaultDeckOptions('Standard');
  const [front, back] = noteType.fields;

  const decks: DeckDoc[] = oldDecks.map((d) => ({
    id: d.id,
    type: 'deck',
    name: d.name,
    optionsId: options.id,
    createdAt: d.createdAt,
  }));

  const notes: NoteDoc[] = [];
  const cards: CardDoc[] = [];
  for (const old of oldCards) {
    const note: NoteDoc = {
      id: makeId('note'),
      type: 'note',
      noteTypeId: noteType.id,
      fields: { [front!]: old.front, [back!]: old.back },
      tags: [],
      createdAt: old.createdAt,
    };
    notes.push(note);
    cards.push({
      id: old.id,
      type: 'card',
      noteId: note.id,
      templateIndex: 0,
      deckId: old.deckId,
      state: stateFromOldCard(old),
      due: old.due,
      dueAt: null,
      suspended: false,
      buried: false,
      flag: 0,
      createdAt: old.createdAt,
    });
  }

  return { noteType, options, decks, notes, cards };
}

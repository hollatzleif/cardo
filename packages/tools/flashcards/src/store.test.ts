import { describe, it, expect } from 'vitest';
import type { ToolStorage } from '@cardo/plugin-api';
import { ensureDefaults, loadCollection, migrateIfNeeded, MODEL_VERSION } from './store';

/** Minimal in-memory ToolStorage for tests (supports the '=' query we use). */
function memoryStorage(): ToolStorage & { dump(): Record<string, unknown> } {
  const map = new Map<string, Record<string, unknown>>();
  return {
    async get(id) {
      return (map.get(id) as never) ?? null;
    },
    async set(id, value) {
      map.set(id, value as Record<string, unknown>);
    },
    async delete(id) {
      map.delete(id);
    },
    async query(q) {
      const where = q?.where ?? [];
      const rows = [...map.values()].filter((doc) =>
        where.every((f) => f.op === '=' && (doc as Record<string, unknown>)[f.field] === f.value),
      );
      return rows as never[];
    },
    subscribe() {
      return () => {};
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

describe('ensureDefaults', () => {
  it('creates a note type and options once, then reuses them', async () => {
    const s = memoryStorage();
    const a = await ensureDefaults(s);
    const b = await ensureDefaults(s);
    expect(a.noteType.id).toBe(b.noteType.id);
    expect(a.options.id).toBe(b.options.id);
    const col = await loadCollection(s);
    expect(col.noteTypes).toHaveLength(1);
    expect(col.options).toHaveLength(1);
  });
});

describe('migrateIfNeeded', () => {
  it('a fresh install just seeds defaults and marks the version', async () => {
    const s = memoryStorage();
    const r = await migrateIfNeeded(s);
    expect(r.migrated).toBe(false);
    const col = await loadCollection(s);
    expect(col.noteTypes).toHaveLength(1);
    expect((await s.get('meta:model')) as { version: number }).toMatchObject({
      version: MODEL_VERSION,
    });
  });

  it('converts old flat decks + cards, preserving ids and due dates', async () => {
    const s = memoryStorage();
    // Seed the OLD flat model.
    await s.set('deck:1', { id: 'deck:1', type: 'deck', name: 'Spanisch', createdAt: '2026-01-01T00:00:00.000Z' });
    await s.set('card:1', {
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
    });

    const r = await migrateIfNeeded(s);
    expect(r.migrated).toBe(true);
    expect(r.cards).toBe(1);

    const col = await loadCollection(s);
    expect(col.decks).toHaveLength(1);
    expect(col.decks[0]!.id).toBe('deck:1');
    expect(col.decks[0]!.optionsId).toBe(col.options[0]!.id); // now a new-model deck
    expect(col.notes).toHaveLength(1);
    expect(col.cards).toHaveLength(1);

    const card = col.cards[0]!;
    expect(card.id).toBe('card:1');
    expect(card.due).toBe('2026-07-20');
    expect(card.state.phase).toBe('review');
    expect(card.state.intervalDays).toBe(12);
    const note = col.notes.find((n) => n.id === card.noteId)!;
    expect(note.fields).toEqual({ Vorderseite: 'hola', Rückseite: 'hallo' });
  });

  it('is idempotent – a second run changes nothing', async () => {
    const s = memoryStorage();
    await s.set('deck:1', { id: 'deck:1', type: 'deck', name: 'D', createdAt: '2026-01-01T00:00:00.000Z' });
    await s.set('card:1', {
      id: 'card:1', type: 'card', deckId: 'deck:1', front: 'a', back: 'b',
      ease: 2.5, intervalDays: 0, due: '2026-07-17', reps: 0, createdAt: '2026-01-02T00:00:00.000Z',
    });
    await migrateIfNeeded(s);
    const first = await loadCollection(s);
    const second = await migrateIfNeeded(s);
    expect(second.migrated).toBe(false);
    const after = await loadCollection(s);
    expect(after.cards).toHaveLength(first.cards.length);
    expect(after.notes).toHaveLength(first.notes.length);
    expect(after.decks).toHaveLength(first.decks.length);
  });
});

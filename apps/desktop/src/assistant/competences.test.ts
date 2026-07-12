import { describe, expect, it, vi } from 'vitest';
import { createMemoryBackend } from '@cardo/core';
import { createMemoryDocStore } from './api';
import { createProfilesStore, SHARED_MEMORY_ID } from './profiles';
import {
  COMPETENCE_SUGGESTION_THRESHOLD,
  competencesMentionTool,
  generateTeamCompetences,
  NOTES_HEADING,
} from './competences';

async function makeStore(competences = '') {
  const store = createProfilesStore({
    backend: createMemoryBackend(),
    docs: createMemoryDocStore(),
    migrateNative: vi.fn(async () => false),
  });
  await store.init();
  const profile = await store.createProfile({
    name: 'Anna',
    emoji: '🦊',
    color: 'accent-3',
    modelId: 'qwen3-4b',
    memoryChoice: { share: SHARED_MEMORY_ID },
    competences,
    toolScope: null,
    personality: '',
    instructions: '',
  });
  return { store, profile };
}

describe('recordProposalOutcome + competenceSuggestions', () => {
  it('suggests a tool after enough accepted proposals (aggregated per tool)', async () => {
    const { store, profile } = await makeStore();
    // 5x todo.create + 3x todo.complete = 8 accepted for tool 'todo'.
    for (let i = 0; i < 5; i += 1) await store.recordProposalOutcome(profile.id, 'todo.create', true);
    for (let i = 0; i < 3; i += 1)
      await store.recordProposalOutcome(profile.id, 'todo.complete', true);
    expect(store.competenceSuggestions()).toEqual([
      { profileId: profile.id, toolId: 'todo', accepted: COMPETENCE_SUGGESTION_THRESHOLD },
    ]);
  });

  it('stays quiet below the threshold and ignores rejected proposals', async () => {
    const { store, profile } = await makeStore();
    for (let i = 0; i < COMPETENCE_SUGGESTION_THRESHOLD - 1; i += 1) {
      await store.recordProposalOutcome(profile.id, 'todo.create', true);
    }
    for (let i = 0; i < 20; i += 1) {
      await store.recordProposalOutcome(profile.id, 'todo.create', false);
    }
    expect(store.competenceSuggestions()).toEqual([]);
  });

  it('suppresses the suggestion when the tool is already mentioned in the competences text', async () => {
    const { store, profile } = await makeStore('Ich verwalte Todo-Listen sehr gut');
    for (let i = 0; i < 10; i += 1) {
      await store.recordProposalOutcome(profile.id, 'todo.create', true);
    }
    expect(store.competenceSuggestions()).toEqual([]);
  });

  it('persists stats across re-init', async () => {
    const { store, profile } = await makeStore();
    for (let i = 0; i < 8; i += 1) await store.recordProposalOutcome(profile.id, 'todo.create', true);
    await store.init();
    expect(store.competenceSuggestions()).toHaveLength(1);
  });
});

describe('competencesMentionTool', () => {
  it('is case-insensitive', () => {
    expect(competencesMentionTool('Verwalte TODO Listen', 'todo')).toBe(true);
    expect(competencesMentionTool('Schreibt Texte', 'todo')).toBe(false);
  });
});

describe('generateTeamCompetences', () => {
  const members = [
    { name: 'Texterin', competences: 'Schreibt gute Texte' },
    { name: 'Coder', competences: '' },
  ];

  it('generates one section per member plus an empty notes section', () => {
    const doc = generateTeamCompetences(members);
    expect(doc).toContain('# Team-Kompetenzen');
    expect(doc).toContain('## Texterin');
    expect(doc).toContain('Schreibt gute Texte');
    expect(doc).toContain('## Coder');
    expect(doc).toContain('(keine Angaben)');
    expect(doc).toContain(NOTES_HEADING);
  });

  it('preserves the user-maintained notes section on regeneration', () => {
    const existing = generateTeamCompetences(members).replace(
      NOTES_HEADING,
      `${NOTES_HEADING}\n- Texterin macht das Kunden-Wording`,
    );
    const regenerated = generateTeamCompetences(
      [...members, { name: 'Neu', competences: 'Recherchiert' }],
      existing,
    );
    expect(regenerated).toContain('## Neu');
    expect(regenerated).toContain('- Texterin macht das Kunden-Wording');
    // The notes section stays at the end, exactly once.
    expect(regenerated.indexOf(NOTES_HEADING)).toBe(regenerated.lastIndexOf(NOTES_HEADING));
    expect(regenerated.indexOf(NOTES_HEADING)).toBeGreaterThan(regenerated.indexOf('## Neu'));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMemoryBackend } from '@cardo/core';
import { MODEL_CATALOG, modelById } from './models';
import { createMemoryDocStore } from './api';
import {
  createProfilesStore,
  DEFAULT_PROFILE_ID,
  modelCompetences,
  modelCompetencesDetailed,
  profileCompetences,
  SHARED_MEMORY_ID,
  type CreateProfileInput,
} from './profiles';

interface StoreOpts {
  /** Seed a legacy persona doc (pre-v0.5 install). Default: true. */
  legacy?: boolean;
  /** Legacy model id stored in core.settings (optional). */
  legacyModelId?: string;
  /** Installed model ids reported to the migration guard. Default: none. */
  installed?: string[];
  migrateNative?: () => Promise<boolean>;
}

async function makeStore(opts: StoreOpts = {}) {
  const backend = createMemoryBackend();
  const docs = createMemoryDocStore();
  if (opts.legacy ?? true) {
    await backend.set('core.settings', 'assistant.persona', {
      value: { assistantName: '', userName: '', style: 'friendly', language: 'de', extra: '' },
    });
  }
  if (opts.legacyModelId !== undefined) {
    await backend.set('core.settings', 'assistant.model', { value: opts.legacyModelId });
  }
  const migrateNative = opts.migrateNative ?? vi.fn(async () => false);
  const listModels = vi.fn(async () => (opts.installed ?? []).map((id) => ({ id })));
  const store = createProfilesStore({ backend, docs, migrateNative, listModels });
  return { backend, docs, store, migrateNative, listModels };
}

function profileInput(overrides: Partial<CreateProfileInput> = {}): CreateProfileInput {
  return {
    name: 'Anna',
    emoji: '🦊',
    color: 'accent-3',
    modelId: 'qwen3-4b',
    memoryChoice: { own: 'Annas Gedächtnis' },
    toolScope: ['calendar'],
    personality: 'PERSONALITY',
    instructions: 'INSTRUCTIONS',
    ...overrides,
  };
}

describe('migration', () => {
  it('creates a default profile from legacy settings (persona + installed model)', async () => {
    const backend = createMemoryBackend();
    await backend.set('core.settings', 'assistant.persona', {
      value: { assistantName: 'Karla', userName: 'Leif', style: 'friendly', language: 'de', extra: '' },
    });
    await backend.set('core.settings', 'assistant.model', { value: 'qwen3-8b' });
    await backend.set('core.settings', 'assistant.askBeforeExecute', { value: false });
    const migrateNative = vi.fn(async () => true);
    const store = createProfilesStore({
      backend,
      docs: createMemoryDocStore(),
      migrateNative,
      listModels: async () => [{ id: 'qwen3-8b' }],
    });

    await store.init();

    expect(migrateNative).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.profiles).toHaveLength(1);
    const profile = state.profiles[0]!;
    expect(profile.id).toBe(DEFAULT_PROFILE_ID);
    expect(profile.name).toBe('Karla');
    expect(profile.emoji).toBe('🤖');
    expect(profile.color).toBe('accent-1');
    expect(profile.modelId).toBe('qwen3-8b');
    expect(profile.memoryId).toBe(SHARED_MEMORY_ID);
    expect(profile.askBeforeExecute).toBe(false);
    expect(state.memories.map((m) => m.id)).toContain(SHARED_MEMORY_ID);
    expect(state.active).toEqual({ type: 'profile', id: DEFAULT_PROFILE_ID });
  });

  it('creates the default profile when only a legacy persona exists (model not installed)', async () => {
    const { store } = await makeStore({ legacy: true, legacyModelId: 'qwen3-8b', installed: [] });
    await store.init();
    expect(store.getState().profiles).toHaveLength(1);
    expect(store.getState().profiles[0]?.id).toBe(DEFAULT_PROFILE_ID);
  });

  it('creates the default profile when only the legacy model is installed (no persona)', async () => {
    const { store } = await makeStore({
      legacy: false,
      legacyModelId: 'qwen3-4b',
      installed: ['qwen3-4b'],
    });
    await store.init();
    const state = store.getState();
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]?.name).toBe('Assistent'); // sensible fallback name
    expect(state.profiles[0]?.modelId).toBe('qwen3-4b');
  });

  it('creates NOTHING on a fresh install (no persona, legacy model not installed)', async () => {
    const { store } = await makeStore({ legacy: false, legacyModelId: 'qwen3-8b', installed: [] });
    await store.init();
    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.profiles).toHaveLength(0);
    expect(state.memories).toHaveLength(0); // no shared memory either
  });

  it('creates NOTHING without any legacy settings at all', async () => {
    const { store } = await makeStore({ legacy: false });
    await store.init();
    expect(store.getState().profiles).toHaveLength(0);
    expect(store.getState().memories).toHaveLength(0);
  });

  it('is idempotent: a second init does not migrate again', async () => {
    const { store, migrateNative } = await makeStore();
    await store.init();
    expect(store.getState().profiles).toHaveLength(1);
    await store.init();
    expect(store.getState().profiles).toHaveLength(1);
    expect(migrateNative).toHaveBeenCalledTimes(1);
  });
});

describe('model-derived competences', () => {
  it('resolves non-empty competences for every catalog model in en and de', () => {
    for (const model of MODEL_CATALOG) {
      for (const language of ['en', 'de'] as const) {
        const line = modelCompetences(model.id, language);
        expect(line, `${model.id} (${language})`).not.toBe('');
        expect(line, `${model.id} (${language})`).not.toContain('assistant.model.');
        const detailed = modelCompetencesDetailed(model.id, language);
        expect(detailed, `${model.id} (${language}) detailed`).not.toBe('');
        expect(detailed.split('\n')).toHaveLength(3); // strengths, weaknesses, idealFor
      }
    }
  });

  it('labels the line with the localized strengths/idealFor labels', () => {
    const de = modelCompetences('qwen3-4b', 'de');
    expect(de).toContain('Stärken:');
    expect(de).toContain('Ideal für:');
    expect(de).toContain(' · ');
    const en = modelCompetences('qwen3-4b', 'en');
    expect(en).toContain('Strengths:');
    expect(en).toContain('Ideal for:');
  });

  it('includes weaknesses only in the detailed variant', () => {
    const detailed = modelCompetencesDetailed('qwen3-4b', 'de');
    expect(detailed).toContain('Schwächen:');
    expect(modelCompetences('qwen3-4b', 'de')).not.toContain('Schwächen:');
  });

  it('returns "" for unknown model ids', () => {
    expect(modelCompetences('no-such-model', 'de')).toBe('');
    expect(modelCompetencesDetailed('no-such-model', 'en')).toBe('');
  });

  it('profileCompetences delegates to the profile model', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput({ modelId: 'qwen3-8b' }));
    expect(profileCompetences(profile, 'de')).toBe(modelCompetences('qwen3-8b', 'de'));
  });
});

describe('profile CRUD', () => {
  it('creates a profile with its own memory and writes both docs', async () => {
    const { store, docs } = await makeStore();
    await store.init();

    const profile = await store.createProfile(profileInput());
    expect(store.getState().profiles).toHaveLength(2);
    expect(await docs.read('profile', profile.id, 'personality')).toBe('PERSONALITY');
    expect(await docs.read('profile', profile.id, 'instructions')).toBe('INSTRUCTIONS');
    const memory = store.getState().memories.find((m) => m.id === profile.memoryId);
    expect(memory?.name).toBe('Annas Gedächtnis');
    expect(profile.toolScope).toEqual(['calendar']);
    // v0.5: no competences input – the stored legacy field stays empty.
    expect(profile.competences).toBe('');
  });

  it('first profile creation on a fresh install ensures the shared memory', async () => {
    const { store } = await makeStore({ legacy: false });
    await store.init();
    expect(store.getState().memories).toHaveLength(0);

    const profile = await store.createProfile(
      profileInput({ memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    expect(profile.memoryId).toBe(SHARED_MEMORY_ID);
    expect(store.getState().memories.map((m) => m.id)).toContain(SHARED_MEMORY_ID);
    // The dangling default active selection is repaired to the new profile.
    expect(store.getActive()).toEqual({ kind: 'profile', profile });
    expect(store.getState().active).toEqual({ type: 'profile', id: profile.id });
  });

  it('can share an existing memory', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(
      profileInput({ memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    expect(profile.memoryId).toBe(SHARED_MEMORY_ID);
  });

  it('rejects sharing an unknown memory', async () => {
    const { store } = await makeStore();
    await store.init();
    await expect(
      store.createProfile(profileInput({ memoryChoice: { share: 'nope' } })),
    ).rejects.toThrow();
  });

  it('updates fields and persists across re-init', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    await store.updateProfile(profile.id, { name: 'Berta', toolScope: null });
    await store.init(); // reload from backend
    const reloaded = store.getState().profiles.find((p) => p.id === profile.id);
    expect(reloaded?.name).toBe('Berta');
    expect(reloaded?.toolScope).toBeNull();
  });

  it('deletes a profile with its docs but NEVER its memory', async () => {
    const { store, docs } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    await store.deleteProfile(profile.id);
    expect(store.getState().profiles.map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID]);
    expect(await docs.read('profile', profile.id, 'personality')).toBe('');
    expect(store.getState().memories.some((m) => m.id === profile.memoryId)).toBe(true);
  });

  it('refuses to delete the last profile', async () => {
    const { store } = await makeStore();
    await store.init();
    await expect(store.deleteProfile(DEFAULT_PROFILE_ID)).rejects.toThrow(/last/);
  });

  it('duplicate copies meta + docs and shares the memory', async () => {
    const { store, docs } = await makeStore();
    await store.init();
    const original = await store.createProfile(profileInput());
    const copy = await store.duplicateProfile(original.id, 'Anna Kopie');
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Anna Kopie');
    expect(copy.memoryId).toBe(original.memoryId);
    expect(await docs.read('profile', copy.id, 'personality')).toBe('PERSONALITY');
    expect(await docs.read('profile', copy.id, 'instructions')).toBe('INSTRUCTIONS');
  });
});

describe('teams', () => {
  it('defaults the leader to the member with the fastest model', async () => {
    const { store } = await makeStore();
    await store.init();
    const big = await store.createProfile(
      profileInput({ name: 'Big', modelId: 'qwen3-8b', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    const tiny = await store.createProfile(
      profileInput({ name: 'Tiny', modelId: 'qwen3-0.6b', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    const team = await store.createTeam({
      name: 'Duo',
      emoji: '👥',
      color: 'accent-5',
      memberIds: [big.id, tiny.id],
      memoryChoice: { own: 'Team-Gedächtnis' },
    });
    expect(team.leaderId).toBe(tiny.id);
  });

  it('rejects a leader who is not a member (create + update)', async () => {
    const { store } = await makeStore();
    await store.init();
    const a = await store.createProfile(
      profileInput({ name: 'A', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    const b = await store.createProfile(
      profileInput({ name: 'B', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    await expect(
      store.createTeam({
        name: 'T',
        emoji: '👥',
        color: 'accent-5',
        memberIds: [a.id],
        leaderId: b.id,
        memoryChoice: { share: SHARED_MEMORY_ID },
      }),
    ).rejects.toThrow(/member/);

    const team = await store.createTeam({
      name: 'T',
      emoji: '👥',
      color: 'accent-5',
      memberIds: [a.id, b.id],
      memoryChoice: { share: SHARED_MEMORY_ID },
    });
    await expect(store.updateTeam(team.id, { memberIds: [a.id], leaderId: b.id })).rejects.toThrow(
      /member/,
    );
  });

  it('repairs teams when a member profile is deleted', async () => {
    const { store } = await makeStore();
    await store.init();
    const a = await store.createProfile(
      profileInput({ name: 'A', modelId: 'qwen3-0.6b', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    const b = await store.createProfile(
      profileInput({ name: 'B', modelId: 'qwen3-8b', memoryChoice: { share: SHARED_MEMORY_ID } }),
    );
    const team = await store.createTeam({
      name: 'T',
      emoji: '👥',
      color: 'accent-5',
      memberIds: [a.id, b.id],
      memoryChoice: { share: SHARED_MEMORY_ID },
    });
    expect(team.leaderId).toBe(a.id);
    await store.deleteProfile(a.id);
    const updated = store.getState().teams.find((t) => t.id === team.id);
    expect(updated?.memberIds).toEqual([b.id]);
    expect(updated?.leaderId).toBe(b.id);
  });
});

describe('active selection + memory resolution', () => {
  it('resolves memory ids for profiles and teams', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    const team = await store.createTeam({
      name: 'Solo',
      emoji: '👥',
      color: 'accent-4',
      memberIds: [profile.id],
      memoryChoice: { own: 'Teamhirn' },
    });
    expect(store.resolveMemoryId({ type: 'profile', id: profile.id })).toBe(profile.memoryId);
    expect(store.resolveMemoryId({ type: 'team', id: team.id })).toBe(team.memoryId);
    expect(() => store.resolveMemoryId({ type: 'profile', id: 'nope' })).toThrow();
  });

  it('setActive/getActive round-trip and fallback after deletion', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    const team = await store.createTeam({
      name: 'Solo',
      emoji: '👥',
      color: 'accent-4',
      memberIds: [profile.id],
      memoryChoice: { share: SHARED_MEMORY_ID },
    });
    await store.setActive({ type: 'team', id: team.id });
    expect(store.getActive()?.kind).toBe('team');
    await store.deleteTeam(team.id);
    expect(store.getActive()?.kind).toBe('profile');
  });

  it('repairs an active selection pointing at a nonexistent profile on init', async () => {
    const { backend, docs, store, migrateNative, listModels } = await makeStore();
    await store.init(); // migration creates the default profile
    // Simulate a dangling persisted selection (profile deleted elsewhere).
    await backend.set('core.settings', 'assistant.active', {
      value: { type: 'profile', id: 'ghost' },
    });
    const reloaded = createProfilesStore({ backend, docs, migrateNative, listModels });
    await reloaded.init();
    expect(reloaded.getState().active).toEqual({ type: 'profile', id: DEFAULT_PROFILE_ID });
  });

  it('keeps the active selection when its profile exists but its model is not installed', async () => {
    // Migration ran on an old install; the model was later deleted. No
    // silent switching – the widget owns that UX.
    const { store } = await makeStore({ legacy: true, legacyModelId: 'qwen3-8b', installed: [] });
    await store.init();
    await store.createProfile(profileInput({ modelId: 'qwen3-4b' }));
    expect(modelById('qwen3-8b')).not.toBeNull();
    expect(store.getState().active).toEqual({ type: 'profile', id: DEFAULT_PROFILE_ID });
  });

  it('lists memory users by name', async () => {
    const { store } = await makeStore();
    await store.init();
    await store.createProfile(profileInput({ name: 'Nutzerin', memoryChoice: { share: SHARED_MEMORY_ID } }));
    const users = store.memoryUsers(SHARED_MEMORY_ID);
    expect(users).toContain('Assistent');
    expect(users).toContain('Nutzerin');
  });
});

describe('memories', () => {
  it('refuses to delete a memory that is in use, allows it afterwards', async () => {
    const { store } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    const owned = profile.memoryId;
    await expect(store.deleteMemory(owned)).rejects.toThrow(/in use/);
    await store.updateProfile(profile.id, { memoryId: SHARED_MEMORY_ID });
    await expect(store.deleteMemory(owned)).resolves.toBeUndefined();
    expect(store.getState().memories.some((m) => m.id === owned)).toBe(false);
  });

  it('renames a memory', async () => {
    const { store } = await makeStore();
    await store.init();
    await store.renameMemory(SHARED_MEMORY_ID, 'Unser Wissen');
    expect(store.getState().memories.find((m) => m.id === SHARED_MEMORY_ID)?.name).toBe(
      'Unser Wissen',
    );
  });
});

describe('export / import', () => {
  it('round-trips a profile including memory', async () => {
    const { store, docs } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    await docs.write('memory', profile.memoryId, 'memory', '- [2026-07-12] mag Kaffee\n');

    const data = await store.exportProfile(profile.id);
    expect(data.version).toBe(1);
    expect(data.personality).toBe('PERSONALITY');
    expect(data.instructions).toBe('INSTRUCTIONS');
    expect(data.memory).toBe('- [2026-07-12] mag Kaffee\n');

    const imported = await store.importProfile(data, { includeMemory: true });
    expect(imported.id).not.toBe(profile.id); // id conflict → suffix
    expect(imported.id).toBe(`${profile.id}-2`);
    expect(imported.name).toBe('Anna (2)'); // name conflict → suffix
    expect(imported.memoryId).not.toBe(profile.memoryId); // own fresh memory
    expect(await docs.read('memory', imported.memoryId, 'memory')).toBe(
      '- [2026-07-12] mag Kaffee\n',
    );
    expect(await docs.read('profile', imported.id, 'personality')).toBe('PERSONALITY');
  });

  it('skips memory content when includeMemory is false', async () => {
    const { store, docs } = await makeStore();
    await store.init();
    const profile = await store.createProfile(profileInput());
    await docs.write('memory', profile.memoryId, 'memory', '- [2026-07-12] privat\n');
    const data = await store.exportProfile(profile.id);
    const imported = await store.importProfile(data, { includeMemory: false });
    expect(await docs.read('memory', imported.memoryId, 'memory')).toBe('');
  });

  it('rejects unsupported exports', async () => {
    const { store } = await makeStore();
    await store.init();
    await expect(
      store.importProfile({ version: 2 } as never, { includeMemory: false }),
    ).rejects.toThrow(/unsupported/);
  });
});

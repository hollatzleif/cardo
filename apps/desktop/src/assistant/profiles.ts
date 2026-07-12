import type { StorageBackend } from '@cardo/core';
import {
  defaultDocStore,
  migrateV1,
  type AssistantDocStore,
} from './api';
import { fastestModelId } from './models';
import { commandToolId } from './catalog';
import { COMPETENCE_SUGGESTION_THRESHOLD, competencesMentionTool } from './competences';
import { readMemory } from './memory';

/**
 * Profile / team / memory store (module-store pattern like inbox/feed.ts).
 *
 * Metadata lives in the backend namespace 'core.assistant'
 * (profile:<id> / team:<id> / memorymeta:<id> / stats:<id> docs), the
 * active selection in core.settings 'assistant.active'. The markdown
 * documents (personality/instructions per profile, memory per memory id)
 * live in the scoped assistant doc store.
 *
 * Everything is testable without Tauri: initProfiles accepts an optional
 * backend + doc store (falling back to getHost().backend and the api doc
 * store), and createProfilesStore builds a fully isolated instance for
 * self-tests.
 */

export interface AssistantProfile {
  id: string;
  name: string;
  emoji: string;
  /** 'accent-1' … 'accent-8' (design token suffix, never a color literal). */
  color: string;
  modelId: string;
  memoryId: string;
  /** Free text: what this profile is good at (shown to router + team). */
  competences: string;
  /** null = all tools; otherwise tool ids (or full command ids). */
  toolScope: string[] | null;
  askBeforeExecute?: boolean;
  delegationAsk?: boolean;
  createdAt: string;
}

export interface AssistantTeam {
  id: string;
  name: string;
  emoji: string;
  color: string;
  memberIds: string[];
  leaderId: string;
  memoryId: string;
  createdAt: string;
}

export interface MemoryMeta {
  id: string;
  name: string;
}

export interface ActiveSelection {
  type: 'profile' | 'team';
  id: string;
}

export interface ProfilesState {
  profiles: AssistantProfile[];
  teams: AssistantTeam[];
  memories: MemoryMeta[];
  active: ActiveSelection;
  loaded: boolean;
}

export type MemoryChoice = { share: string } | { own: string };

export interface CreateProfileInput {
  name: string;
  emoji: string;
  color: string;
  modelId: string;
  memoryChoice: MemoryChoice;
  competences: string;
  toolScope: string[] | null;
  personality: string;
  instructions: string;
  askBeforeExecute?: boolean;
  delegationAsk?: boolean;
}

export interface CreateTeamInput {
  name: string;
  emoji: string;
  color: string;
  memberIds: string[];
  /** Must be a member; defaults to the member with the fastest model. */
  leaderId?: string;
  memoryChoice: MemoryChoice;
}

export interface ProfileExport {
  version: 1;
  profile: AssistantProfile;
  personality: string;
  instructions: string;
  memory?: string;
}

export interface CompetenceSuggestion {
  profileId: string;
  toolId: string;
  accepted: number;
}

export type ResolvedActive =
  | { kind: 'profile'; profile: AssistantProfile }
  | { kind: 'team'; team: AssistantTeam };

interface CommandStats {
  accepted: number;
  rejected: number;
}

export interface ProfilesDeps {
  backend?: StorageBackend;
  docs?: AssistantDocStore;
  /** Rust-side v1 file migration; injectable for tests. */
  migrateNative?: () => Promise<boolean>;
}

const NS = 'core.assistant';
const SETTINGS_NS = 'core.settings';
const ACTIVE_KEY = 'assistant.active';

export const DEFAULT_PROFILE_ID = 'default';
export const SHARED_MEMORY_ID = 'shared';
/** Stored plainly (not an i18n key) – users can rename it any time. */
export const SHARED_MEMORY_NAME = 'Gemeinsam';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface StoredDoc {
  kind: 'profile' | 'team' | 'memorymeta' | 'stats';
  value: Record<string, unknown>;
}

export interface ProfilesStore {
  init(): Promise<void>;
  getState(): ProfilesState;
  onChange(cb: (s: ProfilesState) => void): () => void;
  createProfile(input: CreateProfileInput): Promise<AssistantProfile>;
  updateProfile(
    id: string,
    patch: Partial<Omit<AssistantProfile, 'id' | 'createdAt'>>,
  ): Promise<AssistantProfile>;
  deleteProfile(id: string): Promise<void>;
  duplicateProfile(id: string, newName: string): Promise<AssistantProfile>;
  createTeam(input: CreateTeamInput): Promise<AssistantTeam>;
  updateTeam(
    id: string,
    patch: Partial<Omit<AssistantTeam, 'id' | 'createdAt'>>,
  ): Promise<AssistantTeam>;
  deleteTeam(id: string): Promise<void>;
  createMemory(name: string): Promise<MemoryMeta>;
  renameMemory(id: string, name: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  setActive(sel: ActiveSelection): Promise<void>;
  getActive(): ResolvedActive | null;
  resolveMemoryId(sel: ActiveSelection): string;
  memoryUsers(memoryId: string): string[];
  exportProfile(id: string): Promise<ProfileExport>;
  importProfile(data: ProfileExport, opts: { includeMemory: boolean }): Promise<AssistantProfile>;
  recordProposalOutcome(profileId: string, commandId: string, accepted: boolean): Promise<void>;
  competenceSuggestions(): CompetenceSuggestion[];
}

export function createProfilesStore(deps: ProfilesDeps = {}): ProfilesStore {
  let backendInstance: StorageBackend | null = deps.backend ?? null;
  let docsInstance: AssistantDocStore | null = deps.docs ?? null;
  const migrateNative = deps.migrateNative ?? migrateV1;

  /** Lazy so importing this module never touches the host before init. */
  async function backend(): Promise<StorageBackend> {
    if (!backendInstance) {
      const { getHost } = await import('../host');
      backendInstance = getHost().backend;
    }
    return backendInstance;
  }
  function docs(): AssistantDocStore {
    if (!docsInstance) docsInstance = defaultDocStore();
    return docsInstance;
  }

  let state: ProfilesState = {
    profiles: [],
    teams: [],
    memories: [],
    active: { type: 'profile', id: DEFAULT_PROFILE_ID },
    loaded: false,
  };
  const stats = new Map<string, Record<string, CommandStats>>();
  const listeners = new Set<(s: ProfilesState) => void>();

  function setState(next: Partial<ProfilesState>): void {
    state = { ...state, ...next };
    for (const cb of listeners) cb(state);
  }

  function profileById(id: string): AssistantProfile | null {
    return state.profiles.find((p) => p.id === id) ?? null;
  }
  function teamById(id: string): AssistantTeam | null {
    return state.teams.find((t) => t.id === id) ?? null;
  }

  async function persistProfile(p: AssistantProfile): Promise<void> {
    await (await backend()).set(NS, `profile:${p.id}`, { kind: 'profile', value: p });
  }
  async function persistTeam(t: AssistantTeam): Promise<void> {
    await (await backend()).set(NS, `team:${t.id}`, { kind: 'team', value: t });
  }
  async function persistMemoryMeta(m: MemoryMeta): Promise<void> {
    await (await backend()).set(NS, `memorymeta:${m.id}`, { kind: 'memorymeta', value: m });
  }
  async function persistActive(sel: ActiveSelection): Promise<void> {
    await (await backend()).set(SETTINGS_NS, ACTIVE_KEY, { value: sel });
  }

  function defaultLeader(memberIds: string[]): string {
    const members = memberIds
      .map((id) => profileById(id))
      .filter((p): p is AssistantProfile => p !== null);
    const fastest = fastestModelId(members.map((m) => m.modelId));
    return members.find((m) => m.modelId === fastest)?.id ?? memberIds[0] ?? '';
  }

  async function resolveMemoryChoice(choice: MemoryChoice): Promise<string> {
    if ('share' in choice) {
      if (!state.memories.some((m) => m.id === choice.share)) {
        throw new Error(`unknown memory "${choice.share}"`);
      }
      return choice.share;
    }
    const meta = await createMemory(choice.own);
    return meta.id;
  }

  /** Repairs a dangling active selection (deleted profile/team). */
  async function ensureValidActive(): Promise<void> {
    const { active } = state;
    const valid =
      active.type === 'profile' ? profileById(active.id) !== null : teamById(active.id) !== null;
    if (valid) return;
    const first = state.profiles[0];
    if (!first) return;
    const sel: ActiveSelection = { type: 'profile', id: first.id };
    setState({ active: sel });
    await persistActive(sel);
  }

  /* ── Migration ─────────────────────────────────────────────────────── */

  async function migrateIfNeeded(): Promise<void> {
    if (state.profiles.length > 0) return; // idempotent: already migrated/created
    const be = await backend();
    await migrateNative().catch(() => false);

    const personaDoc = (await be.get(SETTINGS_NS, 'assistant.persona')) as {
      value?: { assistantName?: string };
    } | null;
    const modelDoc = (await be.get(SETTINGS_NS, 'assistant.model')) as { value?: string } | null;
    const askDoc = (await be.get(SETTINGS_NS, 'assistant.askBeforeExecute')) as {
      value?: boolean;
    } | null;

    const shared: MemoryMeta = { id: SHARED_MEMORY_ID, name: SHARED_MEMORY_NAME };
    const profile: AssistantProfile = {
      id: DEFAULT_PROFILE_ID,
      name: personaDoc?.value?.assistantName || 'Assistent',
      emoji: '🤖',
      color: 'accent-1',
      modelId: modelDoc?.value ?? 'qwen3-4b',
      memoryId: SHARED_MEMORY_ID,
      competences: '',
      toolScope: null,
      askBeforeExecute: askDoc?.value !== false,
      createdAt: new Date().toISOString(),
    };
    const active: ActiveSelection = { type: 'profile', id: DEFAULT_PROFILE_ID };

    await persistMemoryMeta(shared);
    setState({ memories: [...state.memories.filter((m) => m.id !== shared.id), shared] });
    await persistProfile(profile);
    setState({ profiles: [profile] });
    await persistActive(active);
    setState({ active });
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  async function init(): Promise<void> {
    const be = await backend();
    const rows = (await be.query(NS, {})) as StoredDoc[];

    const profiles: AssistantProfile[] = [];
    const teams: AssistantTeam[] = [];
    const memories: MemoryMeta[] = [];
    stats.clear();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.kind === 'profile') profiles.push(row.value as unknown as AssistantProfile);
      else if (row.kind === 'team') teams.push(row.value as unknown as AssistantTeam);
      else if (row.kind === 'memorymeta') memories.push(row.value as unknown as MemoryMeta);
      else if (row.kind === 'stats') {
        const v = row.value as { profileId?: string; counts?: Record<string, CommandStats> };
        if (v.profileId) stats.set(v.profileId, v.counts ?? {});
      }
    }
    profiles.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    teams.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    memories.sort((a, b) => a.name.localeCompare(b.name));

    const activeDoc = (await be.get(SETTINGS_NS, ACTIVE_KEY)) as {
      value?: ActiveSelection;
    } | null;

    setState({
      profiles,
      teams,
      memories,
      active: activeDoc?.value ?? { type: 'profile', id: DEFAULT_PROFILE_ID },
      loaded: true,
    });

    await migrateIfNeeded();
    await ensureValidActive();
  }

  function getState(): ProfilesState {
    return state;
  }

  function onChange(cb: (s: ProfilesState) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  async function createProfile(input: CreateProfileInput): Promise<AssistantProfile> {
    const memoryId = await resolveMemoryChoice(input.memoryChoice);
    const profile: AssistantProfile = {
      id: uid('p'),
      name: input.name,
      emoji: input.emoji,
      color: input.color,
      modelId: input.modelId,
      memoryId,
      competences: input.competences,
      toolScope: input.toolScope,
      ...(input.askBeforeExecute !== undefined ? { askBeforeExecute: input.askBeforeExecute } : {}),
      ...(input.delegationAsk !== undefined ? { delegationAsk: input.delegationAsk } : {}),
      createdAt: new Date().toISOString(),
    };
    await docs().write('profile', profile.id, 'personality', input.personality);
    await docs().write('profile', profile.id, 'instructions', input.instructions);
    await persistProfile(profile);
    setState({ profiles: [...state.profiles, profile] });
    return profile;
  }

  async function updateProfile(
    id: string,
    patch: Partial<Omit<AssistantProfile, 'id' | 'createdAt'>>,
  ): Promise<AssistantProfile> {
    const current = profileById(id);
    if (!current) throw new Error(`unknown profile "${id}"`);
    if (patch.memoryId !== undefined && !state.memories.some((m) => m.id === patch.memoryId)) {
      throw new Error(`unknown memory "${patch.memoryId}"`);
    }
    const next: AssistantProfile = { ...current, ...patch, id, createdAt: current.createdAt };
    await persistProfile(next);
    setState({ profiles: state.profiles.map((p) => (p.id === id ? next : p)) });
    return next;
  }

  async function deleteProfile(id: string): Promise<void> {
    const profile = profileById(id);
    if (!profile) throw new Error(`unknown profile "${id}"`);
    if (state.profiles.length <= 1) throw new Error('cannot delete the last profile');

    const be = await backend();
    await be.delete(NS, `profile:${id}`);
    await be.delete(NS, `stats:${id}`);
    stats.delete(id);
    await docs().deleteAll('profile', id);
    // The memory is NEVER deleted here – it may be shared, and even a
    // profile-owned memory stays until deleteMemory is called explicitly.
    setState({ profiles: state.profiles.filter((p) => p.id !== id) });

    // Repair teams that referenced the profile.
    for (const team of state.teams) {
      if (!team.memberIds.includes(id)) continue;
      const memberIds = team.memberIds.filter((m) => m !== id);
      if (memberIds.length === 0) {
        await deleteTeam(team.id);
      } else {
        await updateTeam(team.id, {
          memberIds,
          leaderId: team.leaderId === id ? defaultLeader(memberIds) : team.leaderId,
        });
      }
    }

    await ensureValidActive();
  }

  async function duplicateProfile(id: string, newName: string): Promise<AssistantProfile> {
    const source = profileById(id);
    if (!source) throw new Error(`unknown profile "${id}"`);
    const personality = await docs().read('profile', id, 'personality');
    const instructions = await docs().read('profile', id, 'instructions');
    const copy: AssistantProfile = {
      ...source,
      id: uid('p'),
      name: newName,
      createdAt: new Date().toISOString(),
    };
    await docs().write('profile', copy.id, 'personality', personality);
    await docs().write('profile', copy.id, 'instructions', instructions);
    await persistProfile(copy);
    setState({ profiles: [...state.profiles, copy] });
    return copy;
  }

  async function createTeam(input: CreateTeamInput): Promise<AssistantTeam> {
    if (input.memberIds.length === 0) throw new Error('a team needs at least one member');
    for (const memberId of input.memberIds) {
      if (!profileById(memberId)) throw new Error(`unknown profile "${memberId}"`);
    }
    if (input.leaderId !== undefined && !input.memberIds.includes(input.leaderId)) {
      throw new Error('leader must be a team member');
    }
    const memoryId = await resolveMemoryChoice(input.memoryChoice);
    const team: AssistantTeam = {
      id: uid('t'),
      name: input.name,
      emoji: input.emoji,
      color: input.color,
      memberIds: [...input.memberIds],
      leaderId: input.leaderId ?? defaultLeader(input.memberIds),
      memoryId,
      createdAt: new Date().toISOString(),
    };
    await persistTeam(team);
    setState({ teams: [...state.teams, team] });
    return team;
  }

  async function updateTeam(
    id: string,
    patch: Partial<Omit<AssistantTeam, 'id' | 'createdAt'>>,
  ): Promise<AssistantTeam> {
    const current = teamById(id);
    if (!current) throw new Error(`unknown team "${id}"`);
    const next: AssistantTeam = { ...current, ...patch, id, createdAt: current.createdAt };
    if (next.memberIds.length === 0) throw new Error('a team needs at least one member');
    if (!next.memberIds.includes(next.leaderId)) throw new Error('leader must be a team member');
    if (patch.memoryId !== undefined && !state.memories.some((m) => m.id === patch.memoryId)) {
      throw new Error(`unknown memory "${patch.memoryId}"`);
    }
    await persistTeam(next);
    setState({ teams: state.teams.map((t) => (t.id === id ? next : t)) });
    return next;
  }

  async function deleteTeam(id: string): Promise<void> {
    if (!teamById(id)) throw new Error(`unknown team "${id}"`);
    await (await backend()).delete(NS, `team:${id}`);
    setState({ teams: state.teams.filter((t) => t.id !== id) });
    await ensureValidActive();
  }

  async function createMemory(name: string): Promise<MemoryMeta> {
    const meta: MemoryMeta = { id: uid('m'), name };
    await persistMemoryMeta(meta);
    setState({ memories: [...state.memories, meta] });
    return meta;
  }

  async function renameMemory(id: string, name: string): Promise<void> {
    const meta = state.memories.find((m) => m.id === id);
    if (!meta) throw new Error(`unknown memory "${id}"`);
    const next = { ...meta, name };
    await persistMemoryMeta(next);
    setState({ memories: state.memories.map((m) => (m.id === id ? next : m)) });
  }

  function memoryUsers(memoryId: string): string[] {
    return [
      ...state.profiles.filter((p) => p.memoryId === memoryId).map((p) => p.name),
      ...state.teams.filter((t) => t.memoryId === memoryId).map((t) => t.name),
    ];
  }

  async function deleteMemory(id: string): Promise<void> {
    if (!state.memories.some((m) => m.id === id)) throw new Error(`unknown memory "${id}"`);
    const users = memoryUsers(id);
    if (users.length > 0) {
      throw new Error(`memory is in use by: ${users.join(', ')}`);
    }
    await (await backend()).delete(NS, `memorymeta:${id}`);
    await docs().deleteAll('memory', id);
    setState({ memories: state.memories.filter((m) => m.id !== id) });
  }

  async function setActive(sel: ActiveSelection): Promise<void> {
    const exists = sel.type === 'profile' ? profileById(sel.id) : teamById(sel.id);
    if (!exists) throw new Error(`unknown ${sel.type} "${sel.id}"`);
    setState({ active: sel });
    await persistActive(sel);
  }

  function getActive(): ResolvedActive | null {
    const { active } = state;
    if (active.type === 'team') {
      const team = teamById(active.id);
      if (team) return { kind: 'team', team };
    } else {
      const profile = profileById(active.id);
      if (profile) return { kind: 'profile', profile };
    }
    const first = state.profiles[0];
    return first ? { kind: 'profile', profile: first } : null;
  }

  function resolveMemoryId(sel: ActiveSelection): string {
    if (sel.type === 'team') {
      const team = teamById(sel.id);
      if (!team) throw new Error(`unknown team "${sel.id}"`);
      return team.memoryId;
    }
    const profile = profileById(sel.id);
    if (!profile) throw new Error(`unknown profile "${sel.id}"`);
    return profile.memoryId;
  }

  async function exportProfile(id: string): Promise<ProfileExport> {
    const profile = profileById(id);
    if (!profile) throw new Error(`unknown profile "${id}"`);
    const personality = await docs().read('profile', id, 'personality');
    const instructions = await docs().read('profile', id, 'instructions');
    const memory = await readMemory(profile.memoryId, docs());
    return {
      version: 1,
      profile: { ...profile },
      personality,
      instructions,
      ...(memory !== '' ? { memory } : {}),
    };
  }

  async function importProfile(
    data: ProfileExport,
    opts: { includeMemory: boolean },
  ): Promise<AssistantProfile> {
    if (data.version !== 1 || !data.profile?.id || !data.profile?.name) {
      throw new Error('unsupported profile export');
    }

    let id = data.profile.id;
    for (let n = 2; profileById(id) !== null; n += 1) id = `${data.profile.id}-${n}`;
    let name = data.profile.name;
    for (let n = 2; state.profiles.some((p) => p.name === name); n += 1) {
      name = `${data.profile.name} (${n})`;
    }

    // Imported profiles always get their own memory – the exporting
    // machine's memory ids mean nothing here.
    const meta = await createMemory(name);
    if (opts.includeMemory && data.memory) {
      await docs().write('memory', meta.id, 'memory', data.memory);
    }

    const profile: AssistantProfile = {
      ...data.profile,
      id,
      name,
      memoryId: meta.id,
      createdAt: new Date().toISOString(),
    };
    await docs().write('profile', id, 'personality', data.personality ?? '');
    await docs().write('profile', id, 'instructions', data.instructions ?? '');
    await persistProfile(profile);
    setState({ profiles: [...state.profiles, profile] });
    return profile;
  }

  async function recordProposalOutcome(
    profileId: string,
    commandId: string,
    accepted: boolean,
  ): Promise<void> {
    const counts = stats.get(profileId) ?? {};
    const entry = counts[commandId] ?? { accepted: 0, rejected: 0 };
    if (accepted) entry.accepted += 1;
    else entry.rejected += 1;
    counts[commandId] = entry;
    stats.set(profileId, counts);
    await (await backend()).set(NS, `stats:${profileId}`, {
      kind: 'stats',
      value: { profileId, counts },
    });
  }

  function competenceSuggestions(): CompetenceSuggestion[] {
    const suggestions: CompetenceSuggestion[] = [];
    for (const profile of state.profiles) {
      const counts = stats.get(profile.id);
      if (!counts) continue;
      const byTool = new Map<string, number>();
      for (const [commandId, entry] of Object.entries(counts)) {
        const toolId = commandToolId(commandId);
        byTool.set(toolId, (byTool.get(toolId) ?? 0) + entry.accepted);
      }
      for (const [toolId, accepted] of byTool) {
        if (accepted < COMPETENCE_SUGGESTION_THRESHOLD) continue;
        if (competencesMentionTool(profile.competences, toolId)) continue;
        suggestions.push({ profileId: profile.id, toolId, accepted });
      }
    }
    return suggestions;
  }

  return {
    init,
    getState,
    onChange,
    createProfile,
    updateProfile,
    deleteProfile,
    duplicateProfile,
    createTeam,
    updateTeam,
    deleteTeam,
    createMemory,
    renameMemory,
    deleteMemory,
    setActive,
    getActive,
    resolveMemoryId,
    memoryUsers,
    exportProfile,
    importProfile,
    recordProposalOutcome,
    competenceSuggestions,
  };
}

/* ── Module singleton (what the UI uses) ─────────────────────────────── */

let singleton: ProfilesStore = createProfilesStore();

/**
 * Loads profiles/teams/memories and runs the v1 migration once. Optional
 * deps make the store fully testable without Tauri (pass a memory backend
 * from @cardo/core and createMemoryDocStore from ./api).
 */
export async function initProfiles(deps?: ProfilesDeps): Promise<void> {
  if (deps) singleton = createProfilesStore(deps);
  await singleton.init();
}

export function getProfilesState(): ProfilesState {
  return singleton.getState();
}
export function onProfilesChange(cb: (s: ProfilesState) => void): () => void {
  return singleton.onChange(cb);
}
export function createProfile(input: CreateProfileInput): Promise<AssistantProfile> {
  return singleton.createProfile(input);
}
export function updateProfile(
  id: string,
  patch: Partial<Omit<AssistantProfile, 'id' | 'createdAt'>>,
): Promise<AssistantProfile> {
  return singleton.updateProfile(id, patch);
}
export function deleteProfile(id: string): Promise<void> {
  return singleton.deleteProfile(id);
}
export function duplicateProfile(id: string, newName: string): Promise<AssistantProfile> {
  return singleton.duplicateProfile(id, newName);
}
export function createTeam(input: CreateTeamInput): Promise<AssistantTeam> {
  return singleton.createTeam(input);
}
export function updateTeam(
  id: string,
  patch: Partial<Omit<AssistantTeam, 'id' | 'createdAt'>>,
): Promise<AssistantTeam> {
  return singleton.updateTeam(id, patch);
}
export function deleteTeam(id: string): Promise<void> {
  return singleton.deleteTeam(id);
}
export function createMemory(name: string): Promise<MemoryMeta> {
  return singleton.createMemory(name);
}
export function renameMemory(id: string, name: string): Promise<void> {
  return singleton.renameMemory(id, name);
}
export function deleteMemory(id: string): Promise<void> {
  return singleton.deleteMemory(id);
}
export function setActive(sel: ActiveSelection): Promise<void> {
  return singleton.setActive(sel);
}
export function getActive(): ResolvedActive | null {
  return singleton.getActive();
}
export function resolveMemoryId(sel: ActiveSelection): string {
  return singleton.resolveMemoryId(sel);
}
export function memoryUsers(memoryId: string): string[] {
  return singleton.memoryUsers(memoryId);
}
export function exportProfile(id: string): Promise<ProfileExport> {
  return singleton.exportProfile(id);
}
export function importProfile(
  data: ProfileExport,
  opts: { includeMemory: boolean },
): Promise<AssistantProfile> {
  return singleton.importProfile(data, opts);
}
export function recordProposalOutcome(
  profileId: string,
  commandId: string,
  accepted: boolean,
): Promise<void> {
  return singleton.recordProposalOutcome(profileId, commandId, accepted);
}
export function competenceSuggestions(): CompetenceSuggestion[] {
  return singleton.competenceSuggestions();
}

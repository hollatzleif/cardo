import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../host/backend';
import type { PromptTemplate } from './models';

/**
 * Typed bridge to the Rust assistant commands (multi-assistant contract
 * v0.4.0). Every call is guarded for non-Tauri (plain Vite dev in a browser
 * or node tests): hardware/model calls degrade to "nothing installed", docs
 * fall back to an in-memory store so the UI stays explorable, generation
 * fails cleanly.
 */

export interface AssistantHwInfo {
  totalRamMb: number;
  cpuCores: number;
  arch: string;
  os: string;
  appleSilicon: boolean;
}

export interface InstalledModel {
  id: string;
  sizeBytes: number;
}

export interface DownloadProgress {
  id: string;
  downloadedBytes: number;
  totalBytes: number;
}

/** Which llama.cpp instance a call targets. */
export type ModelSlot = 'main' | 'router' | 'sub';

/** Scoped document store (profiles, memories, team competences). */
export type DocScope = 'profile' | 'memory' | 'team-competences';
export type AssistantDocKind = 'personality' | 'instructions' | 'memory' | 'competences';

/** Error string the Rust side rejects with when a model doesn't fit. */
export const INSUFFICIENT_RAM = 'insufficient-ram';

export function isInsufficientRam(err: unknown): boolean {
  return typeof err === 'string'
    ? err === INSUFFICIENT_RAM
    : err instanceof Error && err.message === INSUFFICIENT_RAM;
}

/** Context window used for every load – plenty for braindump + catalog. */
export const CTX_TOKENS = 4096;

/** window is absent in node tests; treat that as non-Tauri. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && isTauri();
}

export async function fetchHwInfo(): Promise<AssistantHwInfo> {
  if (!inTauri()) {
    return { totalRamMb: 8192, cpuCores: 4, arch: 'dev', os: 'browser', appleSilicon: false };
  }
  return invoke('assistant_hw_info');
}

export async function listModels(): Promise<InstalledModel[]> {
  if (!inTauri()) return [];
  return invoke('assistant_list_models');
}

/** Resolves when the download finished; progress arrives via onDownloadProgress. */
export async function downloadModel(id: string, url: string): Promise<void> {
  await invoke('assistant_download_model', { id, url });
}

export async function cancelDownload(id: string): Promise<void> {
  await invoke('assistant_cancel_download', { id });
}

export async function deleteModel(id: string): Promise<void> {
  await invoke('assistant_delete_model', { id });
}

/**
 * Loads a model into the given slot. Rejects with the string
 * 'insufficient-ram' (see isInsufficientRam) when the model doesn't fit.
 */
export async function loadModel(
  id: string,
  ctxTokens: number = CTX_TOKENS,
  slot: ModelSlot = 'main',
): Promise<void> {
  await invoke('assistant_load_model', { id, ctxTokens, slot });
}

export async function loadedModel(slot: ModelSlot = 'main'): Promise<string | null> {
  if (!inTauri()) return null;
  return invoke('assistant_loaded_model', { slot });
}

export async function unloadModel(slot: ModelSlot = 'main'): Promise<void> {
  if (!inTauri()) return;
  await invoke('assistant_unload_model', { slot });
}

export async function generate(opts: {
  system: string;
  user: string;
  maxTokens: number;
  jsonOnly: boolean;
  template: PromptTemplate;
  slot: ModelSlot;
}): Promise<string> {
  if (!inTauri()) throw new Error('assistant unavailable outside Tauri');
  return invoke('assistant_generate', {
    system: opts.system,
    user: opts.user,
    maxTokens: opts.maxTokens,
    jsonOnly: opts.jsonOnly,
    template: opts.template,
    slot: opts.slot,
  });
}

/* ── Claude (Claude Code CLI via the user's Anthropic account) ───────── */

export interface ClaudeCheckResult {
  installed: boolean;
  version: string | null;
  path: string | null;
}

/** Marker contained in Rust error strings for auth/login problems. */
export const CLAUDE_ERROR_MARKER = 'claude-error';

/** Detects the Claude Code CLI. Non-Tauri environments report "missing". */
export async function claudeCheck(): Promise<ClaudeCheckResult> {
  if (!inTauri()) return { installed: false, version: null, path: null };
  return invoke('claude_check');
}

const CLAUDE_CHECK_TTL_MS = 60_000;
let claudeCheckCache: { at: number; result: ClaudeCheckResult } | null = null;

/**
 * claudeCheck with a 60 s cache – the widget consults it before every
 * generation and the switcher on every refresh, so the CLI probe must stay
 * cheap. `force` bypasses the cache (settings "Erneut prüfen" button).
 */
export async function claudeCheckCached(opts?: { force?: boolean }): Promise<ClaudeCheckResult> {
  const now = Date.now();
  if (!opts?.force && claudeCheckCache && now - claudeCheckCache.at < CLAUDE_CHECK_TTL_MS) {
    return claudeCheckCache.result;
  }
  const result = await claudeCheck().catch(
    (): ClaudeCheckResult => ({ installed: false, version: null, path: null }),
  );
  claudeCheckCache = { at: now, result };
  return result;
}

/**
 * One-shot generation through the Claude Code CLI. The reply is the model's
 * text output (our JSON proposal contract inside – same parseProposals
 * pipeline as local models). Rejects with strings from the Rust side:
 * auth problems contain 'claude-error' (plus a login hint), timeouts
 * contain 'timed out'.
 */
export async function claudeGenerate(opts: {
  system: string;
  user: string;
  model: string;
  workspaceDir: string;
  maxTurns: number;
}): Promise<string> {
  if (!inTauri()) throw new Error('assistant unavailable outside Tauri');
  return invoke('claude_generate', {
    system: opts.system,
    user: opts.user,
    model: opts.model,
    workspaceDir: opts.workspaceDir,
    maxTurns: opts.maxTurns,
  });
}

/* ── Scoped docs ─────────────────────────────────────────────────────── */

/**
 * Minimal doc-store interface: profiles.ts / memory.ts accept any
 * implementation so tests and tool self-tests can run against an isolated
 * in-memory store instead of the Rust bridge.
 */
export interface AssistantDocStore {
  read(scope: DocScope, id: string, kind: AssistantDocKind): Promise<string>;
  write(scope: DocScope, id: string, kind: AssistantDocKind, content: string): Promise<void>;
  deleteAll(scope: DocScope, id: string): Promise<void>;
  listIds(scope: DocScope): Promise<string[]>;
}

/** Isolated in-memory doc store (tests, self-tests, browser dev). */
export function createMemoryDocStore(): AssistantDocStore {
  const docs = new Map<string, string>();
  const key = (scope: DocScope, id: string, kind: AssistantDocKind) => `${scope}\n${id}\n${kind}`;
  return {
    async read(scope, id, kind) {
      return docs.get(key(scope, id, kind)) ?? '';
    },
    async write(scope, id, kind, content) {
      docs.set(key(scope, id, kind), content);
    },
    async deleteAll(scope, id) {
      for (const k of [...docs.keys()]) {
        if (k.startsWith(`${scope}\n${id}\n`)) docs.delete(k);
      }
    },
    async listIds(scope) {
      const ids = new Set<string>();
      for (const k of docs.keys()) {
        const [s, id] = k.split('\n');
        if (s === scope && id !== undefined) ids.add(id);
      }
      return [...ids];
    },
  };
}

function createTauriDocStore(): AssistantDocStore {
  return {
    read: async (scope, id, kind) =>
      (await invoke<string | null>('assistant_read_doc', { scope, id, kind })) ?? '',
    write: async (scope, id, kind, content) => {
      await invoke('assistant_write_doc', { scope, id, kind, content });
    },
    deleteAll: async (scope, id) => {
      await invoke('assistant_delete_docs', { scope, id });
    },
    listIds: async (scope) => invoke('assistant_list_doc_ids', { scope }),
  };
}

let docStore: AssistantDocStore | null = null;

/** The process-wide doc store: Rust bridge in Tauri, in-memory otherwise. */
export function defaultDocStore(): AssistantDocStore {
  if (!docStore) docStore = inTauri() ? createTauriDocStore() : createMemoryDocStore();
  return docStore;
}

export async function readDoc(scope: DocScope, id: string, kind: AssistantDocKind): Promise<string> {
  return defaultDocStore().read(scope, id, kind);
}

export async function writeDoc(
  scope: DocScope,
  id: string,
  kind: AssistantDocKind,
  content: string,
): Promise<void> {
  await defaultDocStore().write(scope, id, kind, content);
}

export async function deleteDocs(scope: DocScope, id: string): Promise<void> {
  await defaultDocStore().deleteAll(scope, id);
}

export async function listDocIds(scope: DocScope): Promise<string[]> {
  return defaultDocStore().listIds(scope);
}

/**
 * Moves v1 single-assistant docs (instructions/personality/memory) into the
 * scoped store on the Rust side. Returns true when anything was migrated.
 */
export async function migrateV1(): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke('assistant_migrate_v1');
}

/** Subscribes to download progress events; returns an unsubscribe function. */
export function onDownloadProgress(cb: (p: DownloadProgress) => void): () => void {
  if (!inTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<DownloadProgress>('assistant:download-progress', (e) => cb(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

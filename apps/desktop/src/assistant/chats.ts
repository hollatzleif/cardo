import type { StorageBackend } from '@cardo/core';

/**
 * Persistent chat store: one document per assistant profile or team in the
 * backend namespace 'core.assistant' (doc id `chat:<ownerId>`, shape
 * { id, entries: ChatEntry[] }).
 *
 * Same pattern as profiles.ts: every function takes an optional backend so
 * tests run against createMemoryBackend from @cardo/core without Tauri; the
 * UI omits it and gets the host backend lazily (importing this module never
 * touches the host).
 */

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatProposalOutcome =
  | 'pending'
  | 'done'
  | 'failed'
  | 'dismissed'
  | 'edited'
  | 'blocked';

/** Snapshot of one proposal card as rendered in the chat. */
export interface ChatProposalSnapshot {
  command: string;
  params: Record<string, unknown>;
  summary: string;
  outcome: ChatProposalOutcome;
}

export interface ChatEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  role: ChatRole;
  /** Profile id behind an assistant answer (team chats: the member who spoke). */
  speakerId?: string;
  text: string;
  proposals?: ChatProposalSnapshot[];
  /** Memory lines the assistant stored alongside this reply. */
  memory?: string[];
  /** Memory doc the lines went to – needed to forget them from history. */
  memoryId?: string;
}

/** Hard cap per chat – the oldest entries are dropped beyond this. */
export const CHAT_MAX_ENTRIES = 200;
/** How many trailing entries are offered to the model as context. */
export const CHAT_CONTEXT_ENTRIES = 12;
/** Above this many context chars the UI suggests /clearchat once. */
export const CHAT_CONTEXT_CHAR_LIMIT = 6000;

const NS = 'core.assistant';

function chatKey(ownerId: string): string {
  return `chat:${ownerId}`;
}

async function resolveBackend(injected?: StorageBackend): Promise<StorageBackend> {
  if (injected) return injected;
  const { getHost } = await import('../host');
  return getHost().backend;
}

function newId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Builds a ChatEntry with a fresh id and timestamp (injectable for tests). */
export function makeChatEntry(input: Omit<ChatEntry, 'id' | 'at'> & { at?: string }): ChatEntry {
  const { at, ...rest } = input;
  return { id: newId(), at: at ?? new Date().toISOString(), ...rest };
}

const ROLES: readonly ChatRole[] = ['user', 'assistant', 'system'];

/** Defensive parse: only well-formed entries survive a load. */
function isChatEntry(value: unknown): value is ChatEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'string' &&
    typeof e.text === 'string' &&
    ROLES.includes(e.role as ChatRole)
  );
}

export async function loadChat(ownerId: string, backend?: StorageBackend): Promise<ChatEntry[]> {
  const be = await resolveBackend(backend);
  const doc = (await be.get(NS, chatKey(ownerId))) as { entries?: unknown } | null;
  if (!doc || !Array.isArray(doc.entries)) return [];
  return doc.entries.filter(isChatEntry);
}

async function persist(ownerId: string, entries: ChatEntry[], be: StorageBackend): Promise<void> {
  await be.set(NS, chatKey(ownerId), {
    id: chatKey(ownerId),
    entries: entries as unknown as Record<string, unknown>[],
  });
}

/** Appends one entry, dropping the oldest beyond CHAT_MAX_ENTRIES. */
export async function appendChat(
  ownerId: string,
  entry: ChatEntry,
  backend?: StorageBackend,
): Promise<void> {
  const be = await resolveBackend(backend);
  const entries = await loadChat(ownerId, be);
  entries.push(entry);
  await persist(ownerId, entries.slice(-CHAT_MAX_ENTRIES), be);
}

/** Patches one entry in place (e.g. a proposal outcome change). */
export async function updateChatEntry(
  ownerId: string,
  entryId: string,
  patch: Partial<Omit<ChatEntry, 'id'>>,
  backend?: StorageBackend,
): Promise<void> {
  const be = await resolveBackend(backend);
  const entries = await loadChat(ownerId, be);
  const next = entries.map((e) => (e.id === entryId ? { ...e, ...patch, id: e.id } : e));
  await persist(ownerId, next, be);
}

export async function clearChat(ownerId: string, backend?: StorageBackend): Promise<void> {
  const be = await resolveBackend(backend);
  await be.delete(NS, chatKey(ownerId));
}

/**
 * The trailing entries a prompt would include as conversation context:
 * user/assistant text only – cards, system lines and empty replies are not
 * part of the prompt history.
 */
export function chatContext(entries: ChatEntry[], max = CHAT_CONTEXT_ENTRIES): ChatEntry[] {
  return entries
    .filter((e) => (e.role === 'user' || e.role === 'assistant') && e.text.trim() !== '')
    .slice(-max);
}

/** Prompt-relevant size of the included history (drives the /clearchat hint). */
export function estimateContextChars(
  entries: ChatEntry[],
  max = CHAT_CONTEXT_ENTRIES,
): number {
  return chatContext(entries, max).reduce((sum, e) => sum + e.text.length, 0);
}

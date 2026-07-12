import { defaultDocStore, type AssistantDocStore } from './api';
import { localIsoDate } from './prompt';

/**
 * Memory documents (scope 'memory', kind 'memory'): one append-only,
 * date-prefixed markdown list per memory id. Several profiles/teams may
 * share one memory id.
 *
 * mergeMemoryLines/removeMemoryLines are pure (unit-tested); the doc store
 * is injectable so tests and self-tests run without Tauri.
 */

export const MEMORY_MAX_LINES = 120;

const DATE_PREFIX = /^-?\s*(\[\d{4}-\d{2}-\d{2}\])?\s*/;

/** Normalizes a line for comparison: strips '- [YYYY-MM-DD] ' and trims. */
export function stripMemoryPrefix(line: string): string {
  return line.replace(DATE_PREFIX, '').trim();
}

/**
 * Pure merge: appends '- [YYYY-MM-DD] entry' lines, dedupes entries whose
 * text already exists (regardless of date), caps at MEMORY_MAX_LINES by
 * dropping the oldest lines.
 */
export function mergeMemoryLines(current: string, entries: string[], isoDate: string): string {
  const lines = current
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  const known = new Set(lines.map(stripMemoryPrefix));

  for (const entry of entries) {
    const text = stripMemoryPrefix(entry);
    if (text === '' || known.has(text)) continue;
    known.add(text);
    lines.push(`- [${isoDate}] ${text}`);
  }

  const capped = lines.slice(-MEMORY_MAX_LINES);
  return capped.length === 0 ? '' : `${capped.join('\n')}\n`;
}

/**
 * Pure removal: drops every line whose text exactly matches one of the
 * given lines – tolerant of the '- [YYYY-MM-DD] ' prefix on either side.
 */
export function removeMemoryLines(current: string, linesToForget: string[]): string {
  const forget = new Set(linesToForget.map(stripMemoryPrefix).filter((l) => l !== ''));
  const kept = current
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !forget.has(stripMemoryPrefix(l)));
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

export async function readMemory(memoryId: string, docs?: AssistantDocStore): Promise<string> {
  const store = docs ?? defaultDocStore();
  return store.read('memory', memoryId, 'memory').catch(() => '');
}

/** Appends durable facts to the memory doc (read → merge → write). */
export async function appendMemory(
  memoryId: string,
  entries: string[],
  now = new Date(),
  docs?: AssistantDocStore,
): Promise<void> {
  if (entries.length === 0) return;
  const store = docs ?? defaultDocStore();
  const current = await readMemory(memoryId, store);
  await store.write('memory', memoryId, 'memory', mergeMemoryLines(current, entries, localIsoDate(now)));
}

/** Removes exactly-matching lines (prefix-tolerant) from the memory doc. */
export async function forgetLines(
  memoryId: string,
  lines: string[],
  docs?: AssistantDocStore,
): Promise<void> {
  if (lines.length === 0) return;
  const store = docs ?? defaultDocStore();
  const current = await readMemory(memoryId, store);
  await store.write('memory', memoryId, 'memory', removeMemoryLines(current, lines));
}

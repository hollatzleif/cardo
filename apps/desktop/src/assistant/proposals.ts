import { z } from 'zod';
import type { CommandResult } from '@cardo/plugin-api';
import { localIsoDate } from './prompt';

/**
 * Proposal pipeline: tolerant parsing of the model's JSON reply, execution
 * via the sanctioned command registry, and the append-only memory doc.
 *
 * parseProposals/mergeMemoryLines are pure (unit-tested); the host and the
 * Rust bridge are pulled in lazily so this module stays importable in a
 * plain node test environment.
 */

export interface AssistantProposal {
  command: string;
  params: Record<string, unknown>;
  summary: string;
}

export interface ParsedResponse {
  reply: string;
  proposals: AssistantProposal[];
  memory: string[];
  /** true when the raw output contained no usable JSON at all. */
  parseError: boolean;
}

const ProposalSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  summary: z.string().default(''),
});

/** Strips ``` fences (with or without a language tag) around the payload. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

/**
 * Tolerant extraction + validation of the model output.
 * Hostile/garbage input never throws: non-JSON yields an empty result with
 * parseError, malformed proposal entries and unknown command ids are
 * silently dropped (the zod schema of the command validates params again
 * at execute time – this is only the first gate).
 */
export function parseProposals(raw: string, hasCommand: (id: string) => boolean): ParsedResponse {
  const empty: ParsedResponse = { reply: '', proposals: [], memory: [], parseError: true };
  const text = stripFences(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;

  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return empty;
  const obj = data as Record<string, unknown>;

  const reply = typeof obj.reply === 'string' ? obj.reply : '';

  const proposals: AssistantProposal[] = [];
  if (Array.isArray(obj.proposals)) {
    for (const item of obj.proposals) {
      const parsed = ProposalSchema.safeParse(item);
      if (parsed.success && hasCommand(parsed.data.command)) proposals.push(parsed.data);
    }
  }

  const memory = Array.isArray(obj.memory)
    ? obj.memory.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
    : [];

  return { reply, proposals, memory, parseError: false };
}

/** Executes one accepted proposal via the command registry (params re-validated there). */
export async function executeProposal(p: AssistantProposal): Promise<CommandResult> {
  const { getHost } = await import('../host');
  return getHost().commands.execute(p.command, p.params);
}

/* ── Memory doc ──────────────────────────────────────────────────────── */

export const MEMORY_MAX_LINES = 120;

const DATE_PREFIX = /^- \[\d{4}-\d{2}-\d{2}\]\s*/;

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
  const known = new Set(lines.map((l) => l.replace(DATE_PREFIX, '').trim()));

  for (const entry of entries) {
    const text = entry.trim();
    if (text === '' || known.has(text)) continue;
    known.add(text);
    lines.push(`- [${isoDate}] ${text}`);
  }

  const capped = lines.slice(-MEMORY_MAX_LINES);
  return capped.length === 0 ? '' : `${capped.join('\n')}\n`;
}

/** Appends durable facts to memory.md (read → merge → write). */
export async function appendMemory(entries: string[], now = new Date()): Promise<void> {
  if (entries.length === 0) return;
  const { readDoc, writeDoc } = await import('./api');
  const current = await readDoc('memory').catch(() => '');
  await writeDoc('memory', mergeMemoryLines(current, entries, localIsoDate(now)));
}

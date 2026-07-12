import { z } from 'zod';
import type { CommandResult } from '@cardo/plugin-api';
import { isCommandInScope } from './catalog';

/**
 * Proposal pipeline: tolerant parsing of the model's JSON reply (including
 * team delegation + forget requests) and execution via the sanctioned
 * command registry, gated by the profile's tool scope.
 *
 * parseProposals is pure (unit-tested); the host is pulled in lazily so
 * this module stays importable in a plain node test environment. The memory
 * doc logic lives in memory.ts.
 */

export interface AssistantProposal {
  command: string;
  params: Record<string, unknown>;
  summary: string;
}

export interface DelegateRequest {
  to: string;
  reason: string;
}

export interface ParsedResponse {
  reply: string;
  proposals: AssistantProposal[];
  memory: string[];
  /** Delegation requests to other team profiles (unknown ids filtered). */
  delegate: DelegateRequest[];
  /** Memory lines the model wants removed (verbatim; prefix-tolerant later). */
  forget: string[];
  /** true when the raw output contained no usable JSON at all. */
  parseError: boolean;
}

const ProposalSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  summary: z.string().default(''),
});

const DelegateSchema = z.object({
  to: z.string().min(1),
  reason: z.string().default(''),
});

/** Strips ``` fences (with or without a language tag) around the payload. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
    : [];
}

/**
 * Tolerant extraction + validation of the model output.
 * Hostile/garbage input never throws: non-JSON yields an empty result with
 * parseError; malformed proposal entries, unknown command ids and delegate
 * targets outside knownProfileIds are silently dropped (the zod schema of
 * the command validates params again at execute time – this is only the
 * first gate).
 */
export function parseProposals(
  raw: string,
  hasCommand: (id: string) => boolean,
  knownProfileIds: string[] = [],
): ParsedResponse {
  const empty: ParsedResponse = {
    reply: '',
    proposals: [],
    memory: [],
    delegate: [],
    forget: [],
    parseError: true,
  };
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

  const delegate: DelegateRequest[] = [];
  if (Array.isArray(obj.delegate)) {
    for (const item of obj.delegate) {
      const parsed = DelegateSchema.safeParse(item);
      if (parsed.success && knownProfileIds.includes(parsed.data.to)) delegate.push(parsed.data);
    }
  }

  return {
    reply,
    proposals,
    memory: stringArray(obj.memory),
    delegate,
    forget: stringArray(obj.forget),
    parseError: false,
  };
}

/** Executes one accepted proposal via the command registry (params re-validated there). */
export async function executeProposal(p: AssistantProposal): Promise<CommandResult> {
  const { getHost } = await import('../host');
  return getHost().commands.execute(p.command, p.params);
}

export interface ExecutedProposal {
  proposal: AssistantProposal;
  result: CommandResult;
}

export interface ExecuteProposalsOutcome {
  executed: ExecutedProposal[];
  blocked: AssistantProposal[];
}

/**
 * Executes proposals through the profile's tool scope: out-of-scope
 * commands are blocked BEFORE any execution attempt (defense in depth – the
 * catalog shown to the model is already scope-filtered).
 * `execute` is injectable for tests/self-tests; defaults to the host
 * command registry.
 */
export async function executeProposals(
  proposals: AssistantProposal[],
  opts: {
    toolScope: string[] | null;
    execute?: (p: AssistantProposal) => Promise<CommandResult>;
  },
): Promise<ExecuteProposalsOutcome> {
  const run = opts.execute ?? executeProposal;
  const executed: ExecutedProposal[] = [];
  const blocked: AssistantProposal[] = [];
  for (const proposal of proposals) {
    if (!isCommandInScope(proposal.command, opts.toolScope)) {
      blocked.push(proposal);
      continue;
    }
    executed.push({ proposal, result: await run(proposal) });
  }
  return { executed, blocked };
}

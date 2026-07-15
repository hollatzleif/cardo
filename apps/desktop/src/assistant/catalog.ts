import { z } from 'zod';

/**
 * Command catalog for the LLM: every palette-visible command with its
 * introspected parameter shape. Pure module – callers hand in the command
 * list (from getHost().commands.list()) and a translate function, which
 * keeps this testable and usable from self-tests.
 */

export type ParamKind = 'string' | 'number' | 'boolean';

export interface CatalogParam {
  name: string;
  kind: ParamKind;
  required: boolean;
  /** Allowed literal values when the underlying schema is an enum. */
  values?: string[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  /** Translated one-line usage description (from CommandSpec.descriptionKey). */
  description?: string;
  params: CatalogParam[];
}

/** Minimal structural view of a CommandSpec (params cast to z.ZodType at the call site). */
export interface CatalogSource {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  params: z.ZodType;
  palette?: boolean;
  assistant?: boolean;
}

/**
 * Introspects a ZodObject into a simple parameter model.
 * Same approach as the command palette's form builder (kept separate on
 * purpose – the assistant must not depend on palette internals).
 */
export function commandParamFields(schema: z.ZodType): CatalogParam[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, field]) => {
    let inner = field;
    let required = true;
    while (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      required = false;
      inner = inner instanceof z.ZodDefault ? inner.removeDefault() : inner.unwrap();
    }
    const kind: ParamKind =
      inner instanceof z.ZodNumber ? 'number' : inner instanceof z.ZodBoolean ? 'boolean' : 'string';
    // Enums stay kind:'string' but carry their literal values so the model
    // proposes valid params instead of guessing.
    if (inner instanceof z.ZodEnum) {
      return { name, kind, required, values: [...(inner.options as string[])] };
    }
    return { name, kind, required };
  });
}

/**
 * Builds the catalog from registered commands. Visibility: the explicit
 * `assistant` flag wins; otherwise palette visibility applies (legacy rule).
 */
export function buildCommandCatalog(
  commands: ReadonlyArray<CatalogSource>,
  t: (key: string) => string,
): CatalogEntry[] {
  return commands
    .filter((c) => c.assistant ?? c.palette !== false)
    .map((c) => ({
      id: c.id,
      title: t(c.titleKey),
      ...(c.descriptionKey ? { description: t(c.descriptionKey) } : {}),
      params: commandParamFields(c.params),
    }));
}

/* ── Tool scope ──────────────────────────────────────────────────────── */

/** 'todo.create' → 'todo' (the owning tool id). */
export function commandToolId(commandId: string): string {
  const dot = commandId.indexOf('.');
  return dot < 0 ? commandId : commandId.slice(0, dot);
}

/**
 * toolScope semantics: null = everything allowed; otherwise a list of tool
 * ids (matched against the command's tool prefix) or full command ids.
 */
export function isCommandInScope(commandId: string, toolScope: string[] | null): boolean {
  if (toolScope === null) return true;
  return toolScope.includes(commandToolId(commandId)) || toolScope.includes(commandId);
}

/** Filters a built catalog down to a profile's tool scope. */
export function filterCatalogByScope(
  entries: CatalogEntry[],
  toolScope: string[] | null,
): CatalogEntry[] {
  if (toolScope === null) return entries;
  return entries.filter((e) => isCommandInScope(e.id, toolScope));
}

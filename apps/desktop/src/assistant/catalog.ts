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
}

export interface CatalogEntry {
  id: string;
  title: string;
  params: CatalogParam[];
}

/** Minimal structural view of a CommandSpec (params cast to z.ZodType at the call site). */
export interface CatalogSource {
  id: string;
  titleKey: string;
  params: z.ZodType;
  palette?: boolean;
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
    return { name, kind, required };
  });
}

/** Builds the catalog from registered commands; palette:false commands are excluded. */
export function buildCommandCatalog(
  commands: ReadonlyArray<CatalogSource>,
  t: (key: string) => string,
): CatalogEntry[] {
  return commands
    .filter((c) => c.palette !== false)
    .map((c) => ({ id: c.id, title: t(c.titleKey), params: commandParamFields(c.params) }));
}

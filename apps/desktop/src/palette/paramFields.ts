import { z } from 'zod';

/**
 * Zod introspection for command parameter forms. Shared by the command
 * palette (Cmd/Ctrl+K) and the diagnose "command-forms" UI check, so the
 * self-test exercises exactly the code path real forms use.
 */

export type ParamField = {
  name: string;
  kind: 'string' | 'number' | 'boolean';
  required: boolean;
};

/** Introspects a ZodObject into a simple form model. */
export function paramFields(schema: z.ZodType): ParamField[] {
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
    const kind =
      inner instanceof z.ZodNumber ? 'number' : inner instanceof z.ZodBoolean ? 'boolean' : 'string';
    return { name, kind, required };
  });
}

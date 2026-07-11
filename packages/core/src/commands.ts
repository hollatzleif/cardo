import type { CommandResult, CommandSpec } from '@cardo/plugin-api';

/**
 * Command registry – the single dispatch point for the palette, shortcuts,
 * tool-to-tool automation, the self-test system and (later) the local AI
 * assistant. Parameters are validated with the command's Zod schema before
 * the handler runs.
 */
export class CommandRegistry {
  private commands = new Map<string, CommandSpec<never>>();

  register<P>(spec: CommandSpec<P>): void {
    if (this.commands.has(spec.id)) {
      throw new Error(`Command "${spec.id}" is already registered`);
    }
    this.commands.set(spec.id, spec as CommandSpec<never>);
  }

  unregister(id: string): void {
    this.commands.delete(id);
  }

  /** Remove all commands of one tool (on deactivate). */
  unregisterTool(toolId: string): void {
    for (const id of this.commands.keys()) {
      if (id.startsWith(`${toolId}.`)) this.commands.delete(id);
    }
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  list(): CommandSpec<never>[] {
    return [...this.commands.values()];
  }

  listForPalette(): CommandSpec<never>[] {
    return this.list().filter((c) => c.palette !== false);
  }

  async execute(id: string, params: unknown): Promise<CommandResult> {
    const spec = this.commands.get(id);
    if (!spec) return { ok: false, messageKey: 'common.error' };
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      return { ok: false, messageKey: 'common.error', data: parsed.error.flatten() };
    }
    try {
      return await spec.run(parsed.data as never);
    } catch (err) {
      console.error(`[cardo] command "${id}" failed:`, err);
      return { ok: false, messageKey: 'common.error', data: String(err) };
    }
  }
}

import { createScratchContext, type DiagnoseCheck, type ScratchServices } from '@cardo/core';
import type { CardoTool } from '@cardo/plugin-api';

/**
 * Coverage guard. A command the AI assistant may invoke must ship with
 * `selfTestParams` – otherwise `buildToolChecks` silently skips it and the
 * command is never exercised by the diagnostics. This walks every tool,
 * activates it in a throwaway scratch context, and returns the ids of
 * assistant-visible commands that are neither self-test covered nor
 * consciously exempt (`selfTestExempt`).
 *
 * Assistant visibility mirrors CommandSpec's default: `assistant` falls back
 * to `palette`, which defaults to true.
 */
export async function findUncoveredCommands(
  factories: Array<() => CardoTool>,
  services: ScratchServices,
): Promise<string[]> {
  const uncovered: string[] = [];
  for (const factory of factories) {
    const { registry, commands } = createScratchContext(services);
    const instance = factory();
    registry.register(instance);
    try {
      await registry.activate(instance.manifest.id);
    } catch {
      // Activation failures surface in the per-tool ping check; not our concern.
    }
    for (const spec of commands.list()) {
      const assistantVisible = spec.assistant ?? spec.palette ?? true;
      const covered = spec.selfTestParams !== undefined || spec.selfTestExempt !== undefined;
      if (assistantVisible && !covered) {
        uncovered.push(spec.id);
      }
    }
  }
  return uncovered;
}

/** Diagnose check: every assistant-visible command is self-test covered. */
export function buildCoverageChecks(
  factories: Array<() => CardoTool>,
  services: ScratchServices,
): DiagnoseCheck[] {
  return [
    {
      id: 'core:coverage',
      titleKey: 'diagnose.check.coverage',
      category: 'core',
      async run() {
        const uncovered = await findUncoveredCommands(factories, services);
        return uncovered.length === 0
          ? { status: 'pass' }
          : {
              status: 'fail',
              detail: `assistant commands without selfTestParams: ${uncovered.join(', ')}`,
            };
      },
    },
  ];
}

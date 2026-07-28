import type { CardoTool, SelfTestResult } from '@cardo/plugin-api';
import { CommandRegistry } from './commands';
import { createMemoryBackend } from './storage';
import { ToolRegistry, type HostServices } from './registry';

/**
 * Self-test system ("Selbsttest starten"). One click → one report.
 * Every check runs against a disposable scratch backend – user data is
 * never touched. Rust-side checks (real DB, file access, …) are injected
 * by the desktop shell as additional DiagnoseChecks.
 */

/** Report sections – rendered in this order (report + settings panel). */
export type DiagnoseCategory =
  | 'core'
  | 'environment'
  | 'tools'
  | 'ui'
  | 'network'
  | 'security';

export const DIAGNOSE_CATEGORIES: readonly DiagnoseCategory[] = [
  'core',
  // Everything else here proves the CODE is correct, against a scratch
  // backend. This category is the only one that looks at the actual
  // INSTALLATION – a logged-out CLI, a second instance on the database, a
  // stale bundle. Those broke real demos while every other check stayed green.
  'environment',
  'tools',
  'ui',
  'network',
  'security',
] as const;

export interface DiagnoseCheck {
  id: string;
  titleKey: string;
  titleVars?: Record<string, string>;
  category: DiagnoseCategory;
  /**
   * The check could not run in this environment (capability absent, wrong
   * platform). Carried through to the result so an unrunnable check stays
   * visible instead of silently counting as green.
   */
  skipped?: boolean;
  run(): Promise<SelfTestResult>;
}

export interface DiagnoseResult {
  id: string;
  titleKey: string;
  titleVars?: Record<string, string>;
  category: DiagnoseCategory;
  status: 'pass' | 'warn' | 'fail';
  skipped?: boolean;
  detail?: string;
  durationMs: number;
}

export interface DiagnoseReport {
  startedAt: string;
  appVersion: string;
  platform: string;
  language: string;
  themeId: string;
  activeTools: string[];
  results: DiagnoseResult[];
  summary: { passed: number; warnings: number; failed: number; skipped: number };
}

export async function runDiagnostics(
  checks: DiagnoseCheck[],
  meta: Omit<DiagnoseReport, 'results' | 'summary' | 'startedAt'>,
  onProgress?: (done: number, total: number, current: DiagnoseResult) => void,
): Promise<DiagnoseReport> {
  const results: DiagnoseResult[] = [];
  for (const check of checks) {
    const start = performance.now();
    let outcome: SelfTestResult;
    try {
      outcome = await check.run();
    } catch (err) {
      outcome = { status: 'fail', detail: String(err) };
    }
    const result: DiagnoseResult = {
      id: check.id,
      titleKey: check.titleKey,
      titleVars: check.titleVars,
      category: check.category,
      status: outcome.status,
      ...(check.skipped ? { skipped: true } : {}),
      detail: 'detail' in outcome ? outcome.detail : undefined,
      durationMs: Math.round(performance.now() - start),
    };
    results.push(result);
    onProgress?.(results.length, checks.length, result);
  }
  return {
    startedAt: new Date().toISOString(),
    ...meta,
    results,
    summary: {
      // Skipped checks are counted only as skipped: rolling them into
      // "warnings" would hide them, rolling them into "passed" would claim a
      // guarantee that was never established.
      passed: results.filter((r) => r.status === 'pass' && !r.skipped).length,
      warnings: results.filter((r) => r.status === 'warn' && !r.skipped).length,
      failed: results.filter((r) => r.status === 'fail' && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
    },
  };
}

/* ── Standard checks built from the tool registry ─────────────────────── */

export interface ToolUnderTest {
  /** Fresh, isolated instance – never the live one (its state must stay untouched). */
  factory: () => CardoTool;
}

/** The services a scratch context borrows from the live host. */
export type ScratchServices = Pick<
  HostServices,
  'events' | 'notifications' | 'scheduler' | 'i18n'
>;

export interface ScratchContext {
  backend: ReturnType<typeof createMemoryBackend>;
  commands: CommandRegistry;
  registry: ToolRegistry;
}

/**
 * Disposable tool environment for diagnose checks: fresh in-memory backend,
 * fresh command registry – user data can never be touched. Shared by the
 * tool checks below and the desktop UI checks.
 *
 * Notifications and the scheduler are STUBBED, never the live services:
 * self-tests execute real command handlers (e.g. hydration.remind), and
 * borrowing the live services here once flooded users with stacked
 * reminder chains – every diagnose run persisted a real schedule whose
 * handle lived only in the throwaway scratch storage (orphaned, self-
 * chaining, one more per run). Only i18n and events stay live.
 */
export function createScratchContext(services: ScratchServices): ScratchContext {
  const backend = createMemoryBackend();
  const commands = new CommandRegistry();
  const inert: Pick<HostServices, 'notifications' | 'scheduler'> = {
    notifications: { notify: async () => {} },
    scheduler: {
      scheduleAt: async () => `scratch-${Math.random().toString(36).slice(2)}`,
      cancel: async () => {},
      list: async () => [],
    },
  };
  const registry = new ToolRegistry({ ...services, ...inert, backend, commands });
  return { backend, commands, registry };
}

export function buildToolChecks(
  { factory }: ToolUnderTest,
  services: ScratchServices,
): DiagnoseCheck[] {
  const manifest = factory().manifest;
  const toolName = manifest.id;

  const makeScratchContext = () => createScratchContext(services);

  const checks: DiagnoseCheck[] = [
    {
      id: `tool:${toolName}:ping`,
      titleKey: 'diagnose.check.toolPing',
      titleVars: { tool: toolName },
      category: 'tools',
      async run() {
        const { registry } = makeScratchContext();
        const instance = factory();
        registry.register(instance);
        await registry.activate(toolName);
        if (!instance.Widget) return { status: 'fail', detail: 'Widget component missing' };
        await registry.deactivate(toolName);
        return { status: 'pass' };
      },
    },
    {
      id: `tool:${toolName}:commands`,
      titleKey: 'diagnose.check.toolCommands',
      titleVars: { tool: toolName },
      category: 'tools',
      async run() {
        const { registry, commands } = makeScratchContext();
        const instance = factory();
        registry.register(instance);
        await registry.activate(toolName);
        const failures: string[] = [];
        for (const spec of commands.list()) {
          if (spec.selfTestParams === undefined) continue;
          const result = await commands.execute(spec.id, spec.selfTestParams);
          if (!result.ok) failures.push(`${spec.id}: ${JSON.stringify(result.data ?? '')}`);
        }
        return failures.length
          ? { status: 'fail', detail: failures.join('; ') }
          : { status: 'pass' };
      },
    },
    ...manifest.selfTests.map(
      (test): DiagnoseCheck => ({
        id: `tool:${toolName}:selftest:${test.id}`,
        titleKey: 'diagnose.check.toolSelfTest',
        titleVars: { tool: toolName, test: test.id },
        category: 'tools',
        async run() {
          const { registry } = makeScratchContext();
          const instance = factory();
          registry.register(instance);
          const ctx = registry.createContext(toolName);
          await instance.activate(ctx);
          return instance.runSelfTest(test.id, ctx);
        },
      }),
    ),
  ];
  return checks;
}

/* ── Report rendering (human + machine readable in ONE file) ──────────── */

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
const SKIPPED_ICON = '⏭️';

export function renderReportMarkdown(
  report: DiagnoseReport,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const lines: string[] = [];
  lines.push(`# ${t('diagnose.reportTitle')}`);
  lines.push('');
  lines.push(`- **App:** Cardo ${report.appVersion}`);
  lines.push(`- **System:** ${report.platform}`);
  lines.push(`- **Language:** ${report.language} · **Theme:** ${report.themeId}`);
  lines.push(`- **Active tools:** ${report.activeTools.join(', ') || '–'}`);
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push('');
  lines.push(
    `**${t('diagnose.summary', {
      passed: report.summary.passed,
      warnings: report.summary.warnings,
      failed: report.summary.failed,
    })}**`,
  );
  if (report.summary.skipped > 0) {
    lines.push('');
    lines.push(`${SKIPPED_ICON} ${t('diagnose.skippedNote', { count: report.summary.skipped })}`);
  }
  lines.push('');
  for (const category of DIAGNOSE_CATEGORIES) {
    const rows = report.results.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    lines.push(`## ${t(`diagnose.category.${category}`)}`);
    lines.push('');
    lines.push(
      `${t('diagnose.summary', {
        passed: rows.filter((r) => r.status === 'pass' && !r.skipped).length,
        warnings: rows.filter((r) => r.status === 'warn' && !r.skipped).length,
        failed: rows.filter((r) => r.status === 'fail' && !r.skipped).length,
      })}`,
    );
    lines.push('');
    lines.push('| | Check | Detail | ms |');
    lines.push('|---|---|---|---|');
    for (const r of rows) {
      const title = t(r.titleKey, r.titleVars).replace(/\|/g, '\\|');
      const detail = (r.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const icon = r.skipped ? SKIPPED_ICON : STATUS_ICON[r.status];
      lines.push(`| ${icon} | ${title} | ${detail} | ${r.durationMs} |`);
    }
    lines.push('');
  }
  lines.push(`> ${t('diagnose.scratchNote')}`);
  lines.push('');
  lines.push('<!-- machine-readable raw result -->');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');
  return lines.join('\n');
}

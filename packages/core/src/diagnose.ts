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

export interface DiagnoseCheck {
  id: string;
  titleKey: string;
  titleVars?: Record<string, string>;
  run(): Promise<SelfTestResult>;
}

export interface DiagnoseResult {
  id: string;
  titleKey: string;
  titleVars?: Record<string, string>;
  status: 'pass' | 'warn' | 'fail';
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
  summary: { passed: number; warnings: number; failed: number };
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
      status: outcome.status,
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
      passed: results.filter((r) => r.status === 'pass').length,
      warnings: results.filter((r) => r.status === 'warn').length,
      failed: results.filter((r) => r.status === 'fail').length,
    },
  };
}

/* ── Standard checks built from the tool registry ─────────────────────── */

export interface ToolUnderTest {
  /** Fresh, isolated instance – never the live one (its state must stay untouched). */
  factory: () => CardoTool;
}

export function buildToolChecks(
  { factory }: ToolUnderTest,
  services: Pick<HostServices, 'events' | 'notifications' | 'scheduler' | 'i18n'>,
): DiagnoseCheck[] {
  const manifest = factory().manifest;
  const toolName = manifest.id;

  const makeScratchContext = () => {
    const backend = createMemoryBackend();
    const commands = new CommandRegistry();
    const registry = new ToolRegistry({ ...services, backend, commands });
    return { backend, commands, registry };
  };

  const checks: DiagnoseCheck[] = [
    {
      id: `tool:${toolName}:ping`,
      titleKey: 'diagnose.check.toolPing',
      titleVars: { tool: toolName },
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
  lines.push('');
  lines.push('| | Check | Detail | ms |');
  lines.push('|---|---|---|---|');
  for (const r of report.results) {
    const title = t(r.titleKey, r.titleVars).replace(/\|/g, '\\|');
    const detail = (r.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${STATUS_ICON[r.status]} | ${title} | ${detail} | ${r.durationMs} |`);
  }
  lines.push('');
  lines.push(`> ${t('diagnose.scratchNote')}`);
  lines.push('');
  lines.push('<!-- machine-readable raw result -->');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');
  return lines.join('\n');
}

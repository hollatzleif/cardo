import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import {
  buildToolChecks,
  runDiagnostics,
  renderReportMarkdown,
  type DiagnoseCheck,
  type DiagnoseReport,
  type DiagnoseResult,
} from '@cardo/core';
import { themes, validateTheme } from '@cardo/themes';
import { resources } from '@cardo/i18n';
import { fetchAppInfo, isTauri } from '../host/backend';
import { getHost } from '../host';
import { toolFactories } from '../host/tools';
import { useAppStore } from '../state/appStore';
import { buildUiChecks } from './uiChecks';
import { buildNetworkChecks } from './networkChecks';
import { buildSecurityChecks } from './securityChecks';
import { buildCoverageChecks } from './coverageChecks';

/** Maps Rust core-check ids to i18n title keys. */
const CORE_CHECK_TITLES: Record<string, string> = {
  'core:storage-path': 'diagnose.check.storagePath',
  'core:db-read-write': 'diagnose.check.dbReadWrite',
  'core:db-query': 'diagnose.check.dbQuery',
  'core:change-log': 'diagnose.check.changeLog',
  'core:migrations': 'diagnose.check.migrations',
  'core:sync-crypto': 'diagnose.check.syncCrypto',
  'core:sync-engine': 'diagnose.check.syncEngine',
  'core:sync-ciphertext': 'diagnose.check.syncCiphertext',
  'core:backup-roundtrip': 'diagnose.check.backupRoundtrip',
};

/** Maps Rust environment-check ids to i18n title keys. */
const ENV_CHECK_TITLES: Record<string, string> = {
  'env:data-dir': 'diagnose.check.envDataDir',
  'env:db-live': 'diagnose.check.envDbLive',
  'env:single-instance': 'diagnose.check.envSingleInstance',
  'env:claude-cli': 'diagnose.check.envClaudeCli',
  'env:claude-auth': 'diagnose.check.envClaudeAuth',
  'env:keychain': 'diagnose.check.envKeychain',
  'env:sync-config': 'diagnose.check.envSyncConfig',
  'env:drive-credentials': 'diagnose.check.envDriveCredentials',
  'env:installed-app': 'diagnose.check.envInstalledApp',
  'env:disk-space': 'diagnose.check.envDiskSpace',
};

interface RustCheckResult {
  id: string;
  status: string;
  detail: string | null;
  skipped?: boolean;
}

/**
 * Replays an already-computed Rust result as a DiagnoseCheck. The work
 * happened in the single `invoke` above; `run()` only reports it.
 */
function fromRustResult(
  r: RustCheckResult,
  category: 'core' | 'environment',
  titles: Record<string, string>,
): DiagnoseCheck {
  return {
    id: r.id,
    titleKey: titles[r.id] ?? r.id,
    category,
    ...(r.skipped ? { skipped: true } : {}),
    run: async () =>
      r.status === 'pass'
        ? r.detail
          ? { status: 'pass', detail: r.detail }
          : { status: 'pass' }
        : { status: r.status as 'warn' | 'fail', detail: r.detail ?? '' },
  };
}

async function coreChecks(): Promise<DiagnoseCheck[]> {
  if (!isTauri()) return [];
  const results = await invoke<RustCheckResult[]>('diagnose_core');
  return results.map((r) => fromRustResult(r, 'core', CORE_CHECK_TITLES));
}

/**
 * Environment checks — the only ones that look at the REAL installation
 * rather than a scratch copy. Browser dev builds have no Tauri bridge, so
 * they contribute nothing there.
 */
async function envChecks(): Promise<DiagnoseCheck[]> {
  if (!isTauri()) return [];
  const results = await invoke<RustCheckResult[]>('diagnose_env');
  return results.map((r) => fromRustResult(r, 'environment', ENV_CHECK_TITLES));
}

function themeCheck(): DiagnoseCheck {
  return {
    id: 'core:themes',
    titleKey: 'diagnose.check.themes',
    category: 'core',
    async run() {
      const problems = themes
        .map((theme) => ({ theme, missing: validateTheme(theme) }))
        .filter(({ missing }) => missing.length > 0);
      return problems.length === 0
        ? { status: 'pass' }
        : {
            status: 'fail',
            detail: problems
              .map(({ theme, missing }) => `${theme.id}: ${missing.join(', ')}`)
              .join('; '),
          };
    },
  };
}

function i18nCheck(): DiagnoseCheck {
  return {
    id: 'core:i18n',
    titleKey: 'diagnose.check.i18n',
    category: 'core',
    async run() {
      const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
        Object.entries(obj).flatMap(([k, v]) =>
          typeof v === 'object' && v !== null
            ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
            : [`${prefix}${k}`],
        );
      const reference = new Set(flatten(resources.en.common));
      const problems: string[] = [];
      for (const [lang, ns] of Object.entries(resources)) {
        const keys = new Set(flatten(ns.common));
        const missing = [...reference].filter((k) => !keys.has(k));
        if (missing.length) problems.push(`${lang}: missing ${missing.length} key(s)`);
      }
      return problems.length === 0
        ? { status: 'pass' }
        : { status: 'fail', detail: problems.join('; ') };
    },
  };
}

export interface RunDiagnoseOptions {
  /** Include the opt-in online cooperation checks (category "network"). */
  includeNetwork?: boolean;
}

export async function runFullDiagnose(
  options: RunDiagnoseOptions = {},
  onProgress?: (done: number, total: number, current: DiagnoseResult) => void,
): Promise<DiagnoseReport> {
  const host = getHost();
  const checks: DiagnoseCheck[] = [
    ...(await coreChecks()),
    ...(await envChecks()),
    themeCheck(),
    i18nCheck(),
    ...Object.values(toolFactories).flatMap((factory) =>
      buildToolChecks({ factory }, host.services),
    ),
    ...buildUiChecks(),
    ...(options.includeNetwork ? buildNetworkChecks() : []),
    ...buildSecurityChecks(),
    ...buildCoverageChecks(Object.values(toolFactories), host.services),
  ];

  const info = await fetchAppInfo();
  const state = useAppStore.getState();
  return runDiagnostics(
    checks,
    {
      appVersion: info.version,
      platform: `${info.platform} (${info.arch})`,
      language: i18next.language,
      themeId: state.themeId,
      activeTools: host.registry.list().filter((t) => t.active).map((t) => t.tool.manifest.id),
    },
    onProgress,
  );
}

export async function exportReport(report: DiagnoseReport): Promise<string> {
  const markdown = renderReportMarkdown(report, (key, vars) =>
    String(i18next.t(key, vars as never)),
  );
  const filename = `cardo-selftest-${report.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.md`;
  if (isTauri()) {
    return invoke<string>('export_report', { filename, content: markdown });
  }
  // Browser dev fallback: trigger a download.
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

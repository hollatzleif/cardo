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

/** Maps Rust core-check ids to i18n title keys. */
const CORE_CHECK_TITLES: Record<string, string> = {
  'core:storage-path': 'diagnose.check.storagePath',
  'core:db-read-write': 'diagnose.check.dbReadWrite',
  'core:db-query': 'diagnose.check.dbQuery',
  'core:change-log': 'diagnose.check.changeLog',
  'core:migrations': 'diagnose.check.migrations',
};

async function coreChecks(): Promise<DiagnoseCheck[]> {
  if (!isTauri()) return [];
  const results = await invoke<Array<{ id: string; status: string; detail: string | null }>>(
    'diagnose_core',
  );
  return results.map((r) => ({
    id: r.id,
    titleKey: CORE_CHECK_TITLES[r.id] ?? r.id,
    run: async () =>
      r.status === 'pass'
        ? { status: 'pass' }
        : { status: r.status as 'warn' | 'fail', detail: r.detail ?? '' },
  }));
}

function themeCheck(): DiagnoseCheck {
  return {
    id: 'core:themes',
    titleKey: 'diagnose.check.themes',
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

export async function runFullDiagnose(
  onProgress?: (done: number, total: number, current: DiagnoseResult) => void,
): Promise<DiagnoseReport> {
  const host = getHost();
  const checks: DiagnoseCheck[] = [
    ...(await coreChecks()),
    themeCheck(),
    i18nCheck(),
    ...Object.values(toolFactories).flatMap((factory) =>
      buildToolChecks({ factory }, host.services),
    ),
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

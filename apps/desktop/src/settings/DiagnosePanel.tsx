import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import { DIAGNOSE_CATEGORIES, type DiagnoseReport, type DiagnoseResult } from '@cardo/core';
import { exportReport, runFullDiagnose } from '../diagnose/runDiagnose';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' } as const;

function ResultRows({ results }: { results: DiagnoseResult[] }) {
  const { t } = useTranslation();
  return (
    <table className="diagnose-panel__table">
      <tbody>
        {results.map((r) => (
          <tr key={r.id}>
            <td>{STATUS_ICON[r.status]}</td>
            <td>{t(r.titleKey, r.titleVars)}</td>
            <td className="c-muted">{r.detail ?? ''}</td>
            <td className="c-muted diagnose-panel__ms">{r.durationMs} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DiagnosePanel() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [includeOnline, setIncludeOnline] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [exportedTo, setExportedTo] = useState<string | null>(null);

  async function start() {
    setRunning(true);
    setReport(null);
    setExportedTo(null);
    try {
      const result = await runFullDiagnose({ includeNetwork: includeOnline }, (done, total) =>
        setProgress([done, total]),
      );
      setReport(result);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="diagnose-panel">
      <p className="c-muted">{t('diagnose.scratchNote')}</p>
      <label>
        <input
          type="checkbox"
          checked={includeOnline}
          disabled={running}
          onChange={(e) => setIncludeOnline(e.target.checked)}
        />{' '}
        {t('diagnose.online.include')}
      </label>
      {includeOnline && <p className="c-muted">{t('diagnose.online.hosts')}</p>}
      <div className="diagnose-panel__actions">
        <Button variant="primary" onClick={() => void start()} disabled={running}>
          {running
            ? `${t('diagnose.running')}${progress ? ` (${progress[0]}/${progress[1]})` : ''}`
            : t('diagnose.start')}
        </Button>
        {report && (
          <Button
            onClick={() => void exportReport(report).then(setExportedTo)}
          >
            {t('diagnose.exportReport')}
          </Button>
        )}
      </div>
      {exportedTo && <p className="c-muted diagnose-panel__exported">→ {exportedTo}</p>}
      {report && (
        <>
          <p>
            <strong>
              {t('diagnose.summary', {
                passed: report.summary.passed,
                warnings: report.summary.warnings,
                failed: report.summary.failed,
              })}
            </strong>
          </p>
          {DIAGNOSE_CATEGORIES.map((category) => {
            const rows = report.results.filter((r) => r.category === category);
            if (rows.length === 0) return null;
            return (
              <div key={category}>
                <h4>
                  {t(`diagnose.category.${category}`)}{' '}
                  <span className="c-muted">
                    {t('diagnose.summary', {
                      passed: rows.filter((r) => r.status === 'pass').length,
                      warnings: rows.filter((r) => r.status === 'warn').length,
                      failed: rows.filter((r) => r.status === 'fail').length,
                    })}
                  </span>
                </h4>
                <ResultRows results={rows} />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

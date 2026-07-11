import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import type { DiagnoseReport } from '@cardo/core';
import { exportReport, runFullDiagnose } from '../diagnose/runDiagnose';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' } as const;

export function DiagnosePanel() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [exportedTo, setExportedTo] = useState<string | null>(null);

  async function start() {
    setRunning(true);
    setReport(null);
    setExportedTo(null);
    try {
      const result = await runFullDiagnose((done, total) => setProgress([done, total]));
      setReport(result);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="diagnose-panel">
      <p className="c-muted">{t('diagnose.scratchNote')}</p>
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
          <table className="diagnose-panel__table">
            <tbody>
              {report.results.map((r) => (
                <tr key={r.id}>
                  <td>{STATUS_ICON[r.status]}</td>
                  <td>{t(r.titleKey, r.titleVars)}</td>
                  <td className="c-muted">{r.detail ?? ''}</td>
                  <td className="c-muted diagnose-panel__ms">{r.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

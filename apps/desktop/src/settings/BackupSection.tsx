import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Button } from '@cardo/ui';
import { isTauri } from '../host/backend';

/** One-click full backup (layout, tasks, settings – everything) + restore. */
export function BackupSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');

  async function exportBackup() {
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `cardo-backup-${date}.json`,
      filters: [{ name: 'Cardo Backup', extensions: ['json'] }],
    });
    if (!path) return;
    try {
      const count = await invoke<number>('backup_export', { path });
      setStatus(t('settings.backupExported', { count }));
    } catch {
      setStatus(t('settings.backupError'));
    }
  }

  async function importBackup() {
    const path = await open({
      multiple: false,
      filters: [{ name: 'Cardo Backup', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    if (!window.confirm(t('settings.backupImportConfirm'))) return;
    try {
      await invoke<number>('backup_import', { path });
      // Restart the UI so every widget reads the restored data.
      window.location.reload();
    } catch {
      setStatus(t('settings.backupError'));
    }
  }

  if (!isTauri()) return null;

  return (
    <div className="settings__row settings__row--block">
      <span>{t('settings.backup')}</span>
      <div className="settings__help-actions">
        <Button onClick={() => void exportBackup()}>{t('settings.backupExport')}</Button>
        <Button onClick={() => void importBackup()}>{t('settings.backupImport')}</Button>
      </div>
      <p className="c-muted">{t('settings.backupHint')}</p>
      {status && <p className="c-muted">{status}</p>}
    </div>
  );
}

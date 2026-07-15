import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Button, Input, Modal, qrMatrix } from '@cardo/ui';
import { isTauri } from '../host/backend';

/**
 * Settings → Sync: key management, transport choice, the mandatory trust
 * warning, device list and manual sync. Sync is opt-in and OFF by default;
 * everything the backend ever sees is end-to-end encrypted in Rust.
 */

interface SyncStatus {
  hasKey: boolean;
  licenseId: string | null;
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  trustConfirmed: boolean;
  transport: string;
  folderPath: string | null;
  webdavUrl: string | null;
  webdavUser: string | null;
  syncLayouts: boolean;
  lastSyncMs: number | null;
  unsyncedOps: number;
  devices: Array<{ deviceId: string; name: string; lastSeenMs: number }>;
  deviceSlots: number;
  gdriveConnected: boolean;
  keyJoinable: boolean;
  keyOrigin: boolean;
  kicked: boolean;
}

interface SyncReport {
  pushed: number;
  pulled: number;
  applied: number;
  skipped: number;
  undecryptable: number;
}

function Row({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-page__row">
      <div className="settings-page__row-text">
        <div className="settings-page__row-label">{label}</div>
        {description && <div className="settings-page__row-desc">{description}</div>}
      </div>
      {children && <div className="settings-page__row-control">{children}</div>}
    </div>
  );
}

/** Renders the sync key as a QR code for phone-free device pairing. */
function KeyQr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const matrix = qrMatrix(value);
    if (!canvas || !matrix) return;
    const quiet = 4;
    const modules = matrix.length + quiet * 2;
    const scale = 4;
    canvas.width = modules * scale;
    canvas.height = modules * scale;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--bg-widget').trim() || 'white';
    const fg = styles.getPropertyValue('--text-primary').trim() || 'black';
    ctx2d.fillStyle = bg;
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = fg;
    matrix.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) ctx2d.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }),
    );
  }, [value]);
  return <canvas ref={canvasRef} style={{ borderRadius: 'var(--radius-sm)' }} aria-label="Sync key QR" />;
}

export function SyncSection({
  Card,
  GroupLabel,
}: {
  Card: React.ComponentType<{ children: React.ReactNode }>;
  GroupLabel: React.ComponentType<{ children: React.ReactNode }>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [webdavPassword, setWebdavPassword] = useState('');

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setStatus(await invoke<SyncStatus>('sync_status'));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const call = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const saveConfig = useCallback(
    (patch: Partial<SyncStatus> & { webdavPassword?: string; trustConfirmed?: boolean }) => {
      if (!status) return Promise.resolve();
      return invoke('sync_configure', {
        args: {
          enabled: patch.enabled ?? status.enabled,
          transport: patch.transport ?? status.transport ?? 'folder',
          folderPath: patch.folderPath !== undefined ? patch.folderPath : status.folderPath,
          webdavUrl: patch.webdavUrl !== undefined ? patch.webdavUrl : status.webdavUrl,
          webdavUser: patch.webdavUser !== undefined ? patch.webdavUser : status.webdavUser,
          webdavPassword: patch.webdavPassword ?? null,
          syncLayouts: patch.syncLayouts ?? status.syncLayouts,
          trustConfirmed: patch.trustConfirmed ?? status.trustConfirmed,
        },
      });
    },
    [status],
  );

  if (!isTauri()) {
    return (
      <Card>
        <Row label={t('settings.sync.title')} description={t('settings.sync.desktopOnly')} />
      </Card>
    );
  }
  if (!status) {
    return (
      <Card>
        <Row label={t('settings.sync.title')} description={error ?? '…'} />
      </Card>
    );
  }

  // Fresh configs carry transport '' – the select DISPLAYS 'folder' as its
  // fallback, so the conditional rows must use the same normalization or
  // the folder picker never appears.
  const transport = status.transport || 'folder';

  return (
    <>
      {status.kicked && (
        <Card>
          <Row
            label={`⚠️ ${t('settings.sync.kickedTitle')}`}
            description={t('settings.sync.kickedBody')}
          />
        </Card>
      )}

      {/* ── How it works (detailed, expandable) ─────────────────────── */}
      <Card>
        <details className="settings-page__wide">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {t('settings.sync.explainTitle')}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {(['what', 'key', 'crypto', 'transports', 'devices', 'limits', 'loss'] as const).map(
              (section) => (
                <div key={section}>
                  <strong style={{ fontSize: 14 }}>{t(`settings.sync.explain.${section}.title`)}</strong>
                  <p className="c-muted" style={{ margin: 'var(--space-1) 0 0', fontSize: 13, lineHeight: 1.6 }}>
                    {t(`settings.sync.explain.${section}.body`)}
                  </p>
                </div>
              ),
            )}
          </div>
        </details>
      </Card>

      {/* ── Key ─────────────────────────────────────────────────────── */}
      <GroupLabel>{t('settings.sync.keyGroup')}</GroupLabel>
      <Card>
        {!status.hasKey ? (
          <>
            <Row
              label={t('settings.sync.noKey')}
              description={t('settings.sync.noKeyHint')}
            >
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void call(async () => {
                    const key = await invoke<string>('sync_generate_key');
                    setRevealedKey(key);
                  })
                }
              >
                {t('settings.sync.generateKey')}
              </Button>
            </Row>
            <Row
              label={t('settings.sync.enterKey')}
              description={t('settings.sync.enterKeyHint')}
            >
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input
                  value={keyInput}
                  placeholder="CRD1-…"
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                <Button
                  disabled={busy || keyInput.trim() === ''}
                  onClick={() =>
                    void call(async () => {
                      await invoke('sync_set_key', { key: keyInput });
                      setKeyInput('');
                    })
                  }
                >
                  {t('common.save')}
                </Button>
              </div>
            </Row>
          </>
        ) : (
          <>
            <Row
              label={t('settings.sync.joinable')}
              description={t('settings.sync.joinableHint')}
            >
              <input
                type="checkbox"
                checked={status.keyJoinable}
                disabled={busy}
                onChange={(e) =>
                  void call(() => invoke('sync_set_joinable', { joinable: e.target.checked }))
                }
              />
            </Row>
            <Row
              label={t('settings.sync.keyPresent')}
              description={`${t('settings.sync.licenseId')}: ${status.licenseId ?? '–'}`}
            >
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button
                  disabled={busy || !status.keyJoinable}
                  title={status.keyJoinable ? undefined : t('settings.sync.joinableOffHint')}
                  onClick={() =>
                    void call(async () => {
                      const key = await invoke<string | null>('sync_reveal_key');
                      setRevealedKey(key);
                    })
                  }
                >
                  {t('settings.sync.showKey')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    const message = status.keyOrigin
                      ? t('settings.sync.forgetConfirmOrigin')
                      : t('settings.sync.forgetConfirm');
                    if (window.confirm(message)) {
                      void call(() => invoke('sync_forget_key'));
                    }
                  }}
                >
                  {status.keyOrigin
                    ? t('settings.sync.deleteKeyOrigin')
                    : t('settings.sync.forgetKey')}
                </Button>
              </div>
            </Row>
            {revealedKey && (
              <div className="settings-page__wide" style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
                <KeyQr value={revealedKey} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
                  <code style={{ userSelect: 'all', overflowWrap: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                    {revealedKey}
                  </code>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button onClick={() => void navigator.clipboard.writeText(revealedKey)}>
                      {t('settings.sync.copyKey')}
                    </Button>
                    <Button variant="ghost" onClick={() => setRevealedKey(null)}>
                      {t('settings.sync.hideKey')}
                    </Button>
                  </div>
                  <span className="c-muted" style={{ fontSize: 12 }}>{t('settings.sync.keyWarning')}</span>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Transport + toggles ─────────────────────────────────────── */}
      {status.hasKey && (
        <>
          <GroupLabel>{t('settings.sync.transportGroup')}</GroupLabel>
          <Card>
            <Row label={t('settings.sync.transport')} description={t('settings.sync.transportHint')}>
              <select
                className="c-input"
                value={transport}
                disabled={busy}
                onChange={(e) => void call(() => saveConfig({ transport: e.target.value }))}
              >
                <option value="folder">{t('settings.sync.transportFolder')}</option>
                <option value="webdav">WebDAV</option>
                <option value="gdrive">Google Drive</option>
              </select>
            </Row>

            {transport === 'folder' && (
              <Row
                label={t('settings.sync.folder')}
                description={status.folderPath ?? t('settings.sync.folderNone')}
              >
                <Button
                  disabled={busy}
                  onClick={() =>
                    void call(async () => {
                      const picked = await open({ directory: true, multiple: false });
                      if (typeof picked === 'string') {
                        await saveConfig({ folderPath: picked });
                      }
                    })
                  }
                >
                  {t('settings.sync.chooseFolder')}
                </Button>
              </Row>
            )}

            {transport === 'webdav' && (
              <>
                <Row label="URL">
                  <Input
                    value={status.webdavUrl ?? ''}
                    placeholder="https://cloud.example.com/remote.php/dav/files/user"
                    onChange={(e) => setStatus({ ...status, webdavUrl: e.target.value })}
                    onBlur={() => void call(() => saveConfig({ webdavUrl: status.webdavUrl }))}
                  />
                </Row>
                <Row label={t('settings.sync.webdavUser')}>
                  <Input
                    value={status.webdavUser ?? ''}
                    onChange={(e) => setStatus({ ...status, webdavUser: e.target.value })}
                    onBlur={() => void call(() => saveConfig({ webdavUser: status.webdavUser }))}
                  />
                </Row>
                <Row label={t('settings.sync.webdavPassword')} description={t('settings.sync.webdavPasswordHint')}>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Input
                      type="password"
                      value={webdavPassword}
                      onChange={(e) => setWebdavPassword(e.target.value)}
                    />
                    <Button
                      disabled={busy || webdavPassword === ''}
                      onClick={() =>
                        void call(async () => {
                          await saveConfig({ webdavPassword });
                          setWebdavPassword('');
                        })
                      }
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                </Row>
              </>
            )}

            {transport === 'gdrive' && (
              <Row
                label="Google Drive"
                description={
                  status.gdriveConnected
                    ? t('settings.sync.gdriveConnected')
                    : t('settings.sync.gdriveHint')
                }
              >
                {status.gdriveConnected ? (
                  <Button
                    disabled={busy}
                    onClick={() => void call(() => invoke('sync_gdrive_disconnect'))}
                  >
                    {t('settings.sync.gdriveDisconnect')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void call(() => invoke('sync_gdrive_connect'))}
                  >
                    {t('settings.sync.gdriveConnect')}
                  </Button>
                )}
              </Row>
            )}

            <Row
              label={t('settings.sync.enable')}
              description={
                transport === 'folder' && !status.folderPath
                  ? t('settings.sync.enableNeedsFolder')
                  : t('settings.sync.enableHint')
              }
            >
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={busy || (transport === 'folder' && !status.folderPath)}
                onChange={(e) => {
                  if (e.target.checked && !status.trustConfirmed) {
                    setTrustOpen(true);
                  } else {
                    void call(() => saveConfig({ enabled: e.target.checked, transport }));
                  }
                }}
              />
            </Row>
            <Row label={t('settings.sync.layouts')} description={t('settings.sync.layoutsHint')}>
              <input
                type="checkbox"
                checked={status.syncLayouts}
                disabled={busy}
                onChange={(e) => void call(() => saveConfig({ syncLayouts: e.target.checked }))}
              />
            </Row>
          </Card>

          {/* ── Status + devices ─────────────────────────────────────── */}
          <GroupLabel>{t('settings.sync.statusGroup')}</GroupLabel>
          <Card>
            <Row
              label={t('settings.sync.lastSync')}
              description={
                status.lastSyncMs
                  ? new Date(status.lastSyncMs).toLocaleString()
                  : t('settings.sync.never')
              }
            >
              <Button
                variant="primary"
                disabled={busy || !status.enabled}
                onClick={() =>
                  void call(async () => {
                    setReport(await invoke<SyncReport>('sync_now'));
                  })
                }
              >
                {busy ? '…' : t('settings.sync.syncNow')}
              </Button>
            </Row>
            <Row
              label={t('settings.sync.pending')}
              description={t('settings.sync.pendingHint')}
            >
              <span className="c-muted">{status.unsyncedOps}</span>
            </Row>
            {report && (
              <Row
                label={t('settings.sync.lastReport')}
                description={t('settings.sync.reportLine', {
                  pushed: report.pushed,
                  applied: report.applied,
                  skipped: report.skipped,
                })}
              />
            )}
            {status.devices.length > 0 && (
              <div className="settings-page__wide">
                <div className="settings-page__row-label" style={{ marginBottom: 'var(--space-2)' }}>
                  {t('settings.sync.devices', {
                    used: status.devices.length,
                    slots: status.deviceSlots,
                  })}
                </div>
                {status.devices.map((device) => (
                  <div
                    key={device.deviceId}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-1) 0' }}
                  >
                    <span>{device.deviceId === status.deviceId ? '💻' : '🖥️'}</span>
                    <span style={{ flex: 1 }}>
                      {device.name}
                      {device.deviceId === status.deviceId && (
                        <span className="c-muted"> · {t('settings.sync.thisDevice')}</span>
                      )}
                    </span>
                    <span className="c-muted" style={{ fontSize: 12 }}>
                      {new Date(device.lastSeenMs).toLocaleDateString()}
                    </span>
                    {device.deviceId !== status.deviceId && status.keyOrigin && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        title={t('settings.sync.kickDevice')}
                        onClick={() => {
                          if (window.confirm(t('settings.sync.kickConfirm', { name: device.name }))) {
                            void call(() =>
                              invoke('sync_remove_device', { deviceId: device.deviceId }),
                            );
                          }
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {error && (
        <Card>
          <Row label={t('settings.sync.errorLabel')} description={<span style={{ color: 'var(--danger)' }}>{error}</span>} />
        </Card>
      )}

      {/* ── Mandatory trust warning ─────────────────────────────────── */}
      {trustOpen && (
        <Modal onClose={() => setTrustOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxWidth: 420 }}>
            <strong>⚠️ {t('settings.sync.trustTitle')}</strong>
            <p style={{ margin: 0 }}>{t('settings.sync.trustBody')}</p>
            <p className="c-muted" style={{ margin: 0, fontSize: 13 }}>{t('settings.sync.trustRecovery')}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setTrustOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setTrustOpen(false);
                  void call(() => saveConfig({ enabled: true, trustConfirmed: true, transport }));
                }}
              >
                {t('settings.sync.trustConfirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

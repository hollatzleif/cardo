import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Button } from '@cardo/ui';
import { themes } from '@cardo/themes';
import { supportedLanguages } from '@cardo/i18n';
import { useAppStore } from '../state/appStore';
import { DiagnosePanel } from './DiagnosePanel';
import { PollsPanel } from './PollsPanel';
import { ProfileModal } from '../profile/ProfileModal';
import { BackupSection } from './BackupSection';
import {
  checkForUpdates,
  getUpdateMode,
  getUpdateStatus,
  installPendingUpdate,
  onUpdateStatus,
  relaunchApp,
  setUpdateMode,
  type UpdateMode,
  type UpdateStatus,
} from '../host/updates';

function UpdatesSection() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<UpdateMode>('auto');
  const [status, setStatus] = useState<UpdateStatus>(getUpdateStatus());

  useEffect(() => {
    void getUpdateMode().then(setMode);
    return onUpdateStatus(setStatus);
  }, []);

  const statusText: Record<UpdateStatus['state'], string> = {
    idle: '',
    checking: t('settings.updateChecking'),
    available: t('settings.updateAvailableTitle', { version: status.version }),
    downloading: t('settings.updateDownloading', { version: status.version }),
    installed: t('settings.updateInstalledTitle', { version: status.version }),
    upToDate: t('settings.updateUpToDate'),
    error: t('settings.updateError'),
  };

  return (
    <div className="settings__row settings__row--block">
      <span>{t('settings.updates')}</span>
      <label className="settings__radio">
        <input
          type="radio"
          name="update-mode"
          checked={mode === 'auto'}
          onChange={() => {
            setMode('auto');
            void setUpdateMode('auto');
          }}
        />
        {t('settings.updatesAuto')}
      </label>
      <label className="settings__radio">
        <input
          type="radio"
          name="update-mode"
          checked={mode === 'notify'}
          onChange={() => {
            setMode('notify');
            void setUpdateMode('notify');
          }}
        />
        {t('settings.updatesNotify')}
      </label>
      <div className="settings__help-actions">
        <Button onClick={() => void checkForUpdates({ background: false })}>
          {t('settings.updateCheckNow')}
        </Button>
        {status.state === 'available' && (
          <Button variant="primary" onClick={() => void installPendingUpdate()}>
            {t('settings.updateInstall')}
          </Button>
        )}
        {status.state === 'installed' && (
          <Button variant="primary" onClick={() => void relaunchApp()}>
            {t('settings.updateRestart')}
          </Button>
        )}
      </div>
      {statusText[status.state] && <p className="c-muted">{statusText[status.state]}</p>}
      <p className="c-muted">{t('settings.updatesTransparency')}</p>
    </div>
  );
}

const ACCENT_TOKENS = [
  'accent-1',
  'accent-2',
  'accent-3',
  'accent-4',
  'accent-5',
  'accent-6',
  'accent-7',
  'accent-8',
] as const;

type Tab = 'general' | 'polls' | 'diagnostics' | 'about';

export function SettingsModal({ onClose }: { onClose(): void }) {
  const { t, i18n } = useTranslation();
  const themeId = useAppStore((s) => s.themeId);
  const accentToken = useAppStore((s) => s.accentToken);
  const setTheme = useAppStore((s) => s.setTheme);
  const setAccent = useAppStore((s) => s.setAccent);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const profile = useAppStore((s) => s.profile);
  const startTour = useAppStore((s) => s.startTour);
  const [tab, setTab] = useState<Tab>('general');
  const [editingProfile, setEditingProfile] = useState(false);

  if (editingProfile) {
    return <ProfileModal initial={profile} onDone={() => setEditingProfile(false)} />;
  }

  return (
    <Modal onClose={onClose}>
      <div className="settings">
        <header className="settings__header">
          <h3>{t('settings.title')}</h3>
          <nav className="settings__tabs">
            {(['general', 'polls', 'diagnostics', 'about'] as Tab[]).map((id) => (
              <button
                key={id}
                className={`c-btn c-btn--ghost${tab === id ? ' settings__tab--active' : ''}`}
                onClick={() => setTab(id)}
              >
                {t(`settings.${id}`)}
              </button>
            ))}
          </nav>
        </header>

        {tab === 'general' && (
          <div className="settings__section">
            <label className="settings__row">
              <span>{t('settings.language')}</span>
              <select
                className="c-input settings__select"
                value={i18n.language}
                onChange={(e) => void setLanguage(e.target.value)}
              >
                {supportedLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang === 'en' ? 'English' : 'Deutsch'}
                  </option>
                ))}
              </select>
            </label>

            <div className="settings__row settings__row--block">
              <span>{t('settings.theme')}</span>
              <div className="settings__themes" data-tour-anchor="ui:theme-picker">
                {themes.map((theme) => (
                  <button
                    key={theme.id}
                    className={`settings__theme-swatch${theme.id === themeId ? ' settings__theme-swatch--active' : ''}`}
                    title={t(theme.nameKey)}
                    onClick={() => void setTheme(theme.id)}
                    style={{
                      // Swatch preview colors come from theme data, not from code.
                      background: theme.palette.base,
                      borderColor: theme.palette['accent-1'],
                    }}
                  >
                    <span style={{ color: theme.palette.text }}>{t(theme.nameKey)}</span>
                    <span
                      className="settings__theme-dot"
                      style={{ background: theme.palette['accent-1'] }}
                    />
                  </button>
                ))}
              </div>
              <p className="c-muted">{t('settings.themeHint')}</p>
            </div>

            <BackupSection />

            <div className="settings__row settings__row--block">
              <span>{t('settings.help')}</span>
              <div className="settings__help-actions">
                <Button onClick={() => setEditingProfile(true)}>{t('profile.edit')}</Button>
                <Button
                  onClick={() => {
                    onClose();
                    startTour();
                  }}
                >
                  {t('onboarding.restart')}
                </Button>
              </div>
              <p className="c-muted">{t('onboarding.restartHint')}</p>
            </div>

            <UpdatesSection />

            <div className="settings__row settings__row--block">
              <span>{t('settings.accentOverride')}</span>
              <div className="settings__accents">
                {ACCENT_TOKENS.map((token) => (
                  <button
                    key={token}
                    className={`settings__accent-dot${accentToken === token ? ' settings__accent-dot--active' : ''}`}
                    style={{ background: `var(--palette-${token})` }}
                    onClick={() => void setAccent(token)}
                  />
                ))}
                <Button variant="ghost" onClick={() => void setAccent(undefined)}>
                  {t('settings.resetOverrides')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {tab === 'polls' && <PollsPanel />}

        {tab === 'diagnostics' && <DiagnosePanel />}

        {tab === 'about' && (
          <div className="settings__section">
            <p>
              <strong>{t('app.name')}</strong> · {t('app.tagline')}
            </p>
            <p className="c-muted">{t('settings.updatesTransparency')}</p>
            <h4>Themes</h4>
            <ul className="c-muted settings__licenses">
              {themes.map((theme) => (
                <li key={theme.id}>
                  {t(theme.nameKey)} · {theme.license.spdx} ·{' '}
                  <span className="settings__license-url">{theme.license.source}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

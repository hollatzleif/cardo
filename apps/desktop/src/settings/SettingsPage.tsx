import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import { themes } from '@cardo/themes';
import { supportedLanguages } from '@cardo/i18n';
import { useAppStore } from '../state/appStore';
import { getHost } from '../host';
import { fetchAppInfo, type AppInfo } from '../host/backend';
import { isInboxEnabled, setInboxEnabled } from '../inbox/feed';
import { AssistantSettings } from '../assistant';
import { MODEL_CATALOG } from '../assistant/models';
import { ProfileModal } from '../profile/ProfileModal';
import { DiagnosePanel } from './DiagnosePanel';
import { PollsPanel } from './PollsPanel';
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
import './settings-page.css';

const DOCS_URL = 'https://hollatzleif.github.io/cardo-app/docs/';

type SectionId =
  | 'general'
  | 'appearance'
  | 'assistant'
  | 'inboxPolls'
  | 'data'
  | 'updates'
  | 'diagnostics'
  | 'help'
  | 'about';

/** Quiet monochrome glyphs – deliberately no colorful emoji in the nav. */
const SECTIONS: Array<{ id: SectionId; glyph: string; labelKey: string }> = [
  { id: 'general', glyph: '⚙', labelKey: 'settings.general' },
  { id: 'appearance', glyph: '◐', labelKey: 'settings.section.appearance' },
  { id: 'assistant', glyph: '✦', labelKey: 'settings.assistant' },
  { id: 'inboxPolls', glyph: '✉', labelKey: 'settings.section.inboxPolls' },
  { id: 'data', glyph: '⬒', labelKey: 'settings.section.data' },
  { id: 'updates', glyph: '↻', labelKey: 'settings.updates' },
  { id: 'diagnostics', glyph: '☂', labelKey: 'settings.diagnostics' },
  { id: 'help', glyph: '?', labelKey: 'settings.help' },
  { id: 'about', glyph: 'ℹ', labelKey: 'settings.about' },
];

/* ── Building blocks (macOS/Obsidian-style grouped rows) ────────────────── */

function Card({ children }: { children: ReactNode }) {
  return <section className="settings-page__card">{children}</section>;
}

function Row({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
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

/** Full-width block inside a card (theme grid, panels, license lists). */
function Wide({ children }: { children: ReactNode }) {
  return <div className="settings-page__wide">{children}</div>;
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="settings-page__group-label">{children}</h3>;
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="settings-page__footnote">{children}</p>;
}

/* ── Sections ───────────────────────────────────────────────────────────── */

function GeneralSection({ onEditProfile }: { onEditProfile(): void }) {
  const { t, i18n } = useTranslation();
  const setLanguage = useAppStore((s) => s.setLanguage);
  return (
    <Card>
      <Row label={t('settings.language')} description={t('settings.languageDesc')}>
        <select
          className="c-input"
          value={i18n.language}
          onChange={(e) => void setLanguage(e.target.value)}
        >
          {supportedLanguages.map((lang) => (
            <option key={lang} value={lang}>
              {lang === 'en' ? 'English' : 'Deutsch'}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('settings.profile')} description={t('settings.profileDesc')}>
        <Button onClick={onEditProfile}>{t('profile.edit')}</Button>
      </Row>
    </Card>
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

function AppearanceSection() {
  const { t } = useTranslation();
  const themeId = useAppStore((s) => s.themeId);
  const accentToken = useAppStore((s) => s.accentToken);
  const setTheme = useAppStore((s) => s.setTheme);
  const setAccent = useAppStore((s) => s.setAccent);
  return (
    <>
      <Card>
        <Wide>
          <div className="settings-page__row-label">{t('settings.theme')}</div>
          <div className="settings-page__row-desc">{t('settings.themeHint')}</div>
          <div className="settings__themes settings-page__themes" data-tour-anchor="ui:theme-picker">
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
        </Wide>
        <Row label={t('settings.accentOverride')}>
          <div className="settings__accents">
            {ACCENT_TOKENS.map((token) => (
              <button
                key={token}
                className={`settings__accent-dot${accentToken === token ? ' settings__accent-dot--active' : ''}`}
                title={token}
                style={{ background: `var(--palette-${token})` }}
                onClick={() => void setAccent(token)}
              />
            ))}
            <Button variant="ghost" onClick={() => void setAccent(undefined)}>
              {t('settings.resetOverrides')}
            </Button>
          </div>
        </Row>
      </Card>
      <Footnote>{t('settings.appearanceEditHint')}</Footnote>
    </>
  );
}

function InboxPollsSection() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void isInboxEnabled().then(setEnabled);
  }, []);
  return (
    <>
      <Card>
        <Row label={t('inbox.title')} description={t('inbox.privacyNote')}>
          <Button
            onClick={() => {
              const next = !enabled;
              setEnabled(next);
              void setInboxEnabled(next);
            }}
          >
            {enabled ? t('inbox.disable') : t('inbox.enable')}
          </Button>
        </Row>
      </Card>
      <GroupLabel>{t('settings.polls')}</GroupLabel>
      <Card>
        <Wide>
          <PollsPanel />
        </Wide>
      </Card>
    </>
  );
}

function DataSection() {
  const { t } = useTranslation();
  const files = getHost().services.files;
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    void files?.getFolder().then(setFolder);
    // The files service never changes at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeFolder() {
    if (!files) return;
    const picked = await files.pickFolder();
    if (!picked) return;
    await files.setFolder(picked);
    setFolder(picked);
  }

  return (
    <Card>
      {/* Backup lives in its own component (Tauri-only; renders nothing in dev). */}
      <BackupSection />
      <Row
        label={t('settings.notesFolder')}
        description={
          folder ? (
            <span className="settings-page__url">{folder}</span>
          ) : (
            t('settings.notesFolderNone')
          )
        }
      >
        <Button onClick={() => void changeFolder()} disabled={!files}>
          {t('settings.notesFolderChange')}
        </Button>
      </Row>
    </Card>
  );
}

function UpdatesSection() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<UpdateMode>('auto');
  const [status, setStatus] = useState<UpdateStatus>(getUpdateStatus());

  useEffect(() => {
    void getUpdateMode().then(setMode);
    return onUpdateStatus(setStatus);
  }, []);

  const statusText: Record<UpdateStatus['state'], string> = {
    idle: t('settings.updateStatusIdle'),
    checking: t('settings.updateChecking'),
    available: t('settings.updateAvailableTitle', { version: status.version }),
    downloading: t('settings.updateDownloading', { version: status.version }),
    installed: t('settings.updateInstalledTitle', { version: status.version }),
    upToDate: t('settings.updateUpToDate'),
    error: t('settings.updateError'),
  };

  function pick(next: UpdateMode) {
    setMode(next);
    void setUpdateMode(next);
  }

  return (
    <>
      <Card>
        <Row label={t('settings.updatesAuto')}>
          <input
            type="radio"
            name="update-mode"
            checked={mode === 'auto'}
            onChange={() => pick('auto')}
          />
        </Row>
        <Row label={t('settings.updatesNotify')}>
          <input
            type="radio"
            name="update-mode"
            checked={mode === 'notify'}
            onChange={() => pick('notify')}
          />
        </Row>
        <Row label={statusText[status.state]}>
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
        </Row>
      </Card>
      <Footnote>{t('settings.updatesTransparency')}</Footnote>
    </>
  );
}

function HelpSection() {
  const { t } = useTranslation();
  const startTour = useAppStore((s) => s.startTour);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  return (
    <Card>
      <Row label={t('settings.tour')} description={t('onboarding.restartHint')}>
        <Button
          onClick={() => {
            setSettingsOpen(false);
            startTour();
          }}
        >
          {t('onboarding.restart')}
        </Button>
      </Row>
      <Row
        label={t('settings.docsLink')}
        description={t('settings.docsLinkDesc')}
      >
        <span className="settings-page__url">{DOCS_URL}</span>
      </Row>
    </Card>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void fetchAppInfo().then(setInfo);
  }, []);
  return (
    <>
      <Card>
        <Row label={t('app.name')} description={t('app.tagline')}>
          {info && (
            <span className="c-muted">
              {t('settings.version')} {info.version} · {info.platform}/{info.arch}
            </span>
          )}
        </Row>
      </Card>
      <Footnote>{t('settings.updatesTransparency')}</Footnote>
      <GroupLabel>Themes</GroupLabel>
      <Card>
        <Wide>
          <ul className="c-muted settings-page__licenses">
            {themes.map((theme) => (
              <li key={theme.id}>
                {t(theme.nameKey)} · {theme.license.spdx} ·{' '}
                <span className="settings-page__url">{theme.license.source}</span>
              </li>
            ))}
          </ul>
        </Wide>
      </Card>
      <GroupLabel>{t('settings.aiLicenses')}</GroupLabel>
      <Card>
        <Wide>
          <ul className="c-muted settings-page__licenses">
            {MODEL_CATALOG.map((model) => (
              <li key={model.id}>
                {model.label} · {model.license.name}
                {model.license.notice === 'llama' ? ' · Built with Llama' : ''} ·{' '}
                <span className="settings-page__url">{model.license.url}</span>
              </li>
            ))}
          </ul>
        </Wide>
      </Card>
    </>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

/**
 * Fullscreen settings, modeled on Obsidian / macOS System Settings:
 * left sidebar navigation, right content column with grouped setting rows.
 * Replaces the old cramped SettingsModal.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const profile = useAppStore((s) => s.profile);
  const [section, setSection] = useState<SectionId>('general');
  const [editingProfile, setEditingProfile] = useState(false);

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;

  return (
    <div className="settings-page">
      <nav className="settings-page__nav" aria-label={t('settings.title')}>
        <div className="settings-page__nav-head">
          <button
            className="c-btn c-btn--ghost settings-page__back"
            onClick={() => setSettingsOpen(false)}
          >
            ← {t('settings.back')}
          </button>
          <h1 className="settings-page__title">{t('settings.title')}</h1>
        </div>
        {SECTIONS.map(({ id, glyph, labelKey }) => (
          <button
            key={id}
            className={`settings-page__nav-item${id === section ? ' settings-page__nav-item--active' : ''}`}
            onClick={() => setSection(id)}
          >
            <span className="settings-page__nav-glyph" aria-hidden="true">
              {glyph}
            </span>
            <span className="settings-page__nav-label">{t(labelKey)}</span>
          </button>
        ))}
      </nav>

      <div className="settings-page__content">
        <div className="settings-page__content-inner">
          <h2 className="settings-page__section-title">{t(active.labelKey)}</h2>
          <p className="settings-page__section-desc">{t(`settings.sectionDesc.${section}`)}</p>

          {section === 'general' && (
            <GeneralSection onEditProfile={() => setEditingProfile(true)} />
          )}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'assistant' && (
            <Card>
              <Wide>
                <AssistantSettings />
              </Wide>
            </Card>
          )}
          {section === 'inboxPolls' && <InboxPollsSection />}
          {section === 'data' && <DataSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'diagnostics' && (
            <Card>
              <Wide>
                <DiagnosePanel />
              </Wide>
            </Card>
          )}
          {section === 'help' && <HelpSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>

      {editingProfile && (
        <ProfileModal initial={profile} onDone={() => setEditingProfile(false)} />
      )}
    </div>
  );
}

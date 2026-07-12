import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from './state/appStore';
import { getHost } from './host';
import { Canvas } from './canvas/Canvas';
import { CommandPalette } from './palette/CommandPalette';
import { SettingsModal } from './settings/SettingsModal';
import { ToolMarket } from './market/ToolMarket';
import { ProfileModal } from './profile/ProfileModal';
import { Tour } from './onboarding/Tour';
import { TemplatePicker } from './onboarding/TemplatePicker';
import { DesignPanel } from './design/DesignPanel';
import { FocusMode } from './focus/FocusMode';

function greetingKey(hour: number): string {
  if (hour < 11) return 'profile.greetingMorning';
  if (hour < 18) return 'profile.greetingDay';
  return 'profile.greetingEvening';
}

interface Toast {
  id: number;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

export function App() {
  const { t } = useTranslation();
  const editing = useAppStore((s) => s.editing);
  const setEditing = useAppStore((s) => s.setEditing);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const pages = useAppStore((s) => s.pages);
  const currentPageId = useAppStore((s) => s.currentPageId);
  const selectPage = useAppStore((s) => s.selectPage);
  const addPage = useAppStore((s) => s.addPage);
  const renamePage = useAppStore((s) => s.renamePage);
  const removePage = useAppStore((s) => s.removePage);
  const marketOpen = useAppStore((s) => s.marketOpen);
  const setMarketOpen = useAppStore((s) => s.setMarketOpen);
  const designOpen = useAppStore((s) => s.designOpen);
  const setDesignOpen = useAppStore((s) => s.setDesignOpen);
  const focusOpen = useAppStore((s) => s.focusOpen);
  const setFocusOpen = useAppStore((s) => s.setFocusOpen);
  const profile = useAppStore((s) => s.profile);
  const onboardingDone = useAppStore((s) => s.onboardingDone);
  const tourActive = useAppStore((s) => s.tourActive);
  const startTour = useAppStore((s) => s.startTour);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!useAppStore.getState().paletteOpen);
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setEditing(!useAppStore.getState().editing);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setEditing, setPaletteOpen]);

  // First start: profile → template picker → tour. If the app was closed
  // mid-onboarding, resume the tour on the next start (still skippable).
  useEffect(() => {
    if (profile && !onboardingDone && !tourActive && !showTemplates) startTour();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, showTemplates]);

  useEffect(() => {
    let nextId = 1;
    return getHost().services.events.on('core:toast', (payload) => {
      const p = payload as {
        title?: unknown;
        body?: string;
        actionLabel?: string;
        onAction?: () => void | Promise<void>;
      };
      const toast: Toast = {
        id: nextId++,
        title: String(p.title ?? ''),
        body: p.body,
        actionLabel: p.actionLabel,
        onAction: p.onAction,
      };
      setToasts((ts) => [...ts, toast]);
      // Toasts with an action (undo!) stay longer.
      const ttl = toast.onAction ? 7000 : 4000;
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== toast.id)), ttl);
    });
  }, []);

  const needsProfile = !profile;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">{t('app.name')}</span>
        {profile && (
          <span className="c-muted topbar__greeting">
            {t(greetingKey(new Date().getHours()), { name: profile.name })}
          </span>
        )}
        <nav className="topbar__pages">
          {pages.map((page) =>
            renaming === page.id ? (
              <input
                key={page.id}
                className="c-input topbar__rename"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => {
                  if (renameValue.trim()) void renamePage(page.id, renameValue.trim());
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <button
                key={page.id}
                className={`c-btn c-btn--ghost topbar__page${page.id === currentPageId ? ' topbar__page--active' : ''}`}
                onClick={() => selectPage(page.id)}
                onDoubleClick={() => {
                  setRenaming(page.id);
                  setRenameValue(page.name);
                }}
              >
                {page.name}
                {editing && pages.length > 1 && page.id === currentPageId && (
                  <span
                    className="topbar__page-delete"
                    title={t('canvas.deletePage')}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(t('canvas.deletePageConfirm'))) void removePage(page.id);
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            ),
          )}
          {editing && (
            <button
              className="c-btn c-btn--ghost"
              title={t('canvas.addPage')}
              onClick={() => void addPage()}
            >
              +
            </button>
          )}
        </nav>
        <div className="topbar__actions">
          <button
            className={`c-btn${editing ? ' c-btn--primary' : ''}`}
            title={`${t('canvas.toggleEdit')} (⌘/Ctrl+E)`}
            data-tour-anchor="ui:edit-toggle"
            onClick={() => setEditing(!editing)}
          >
            {editing ? t('canvas.editMode') : t('canvas.viewMode')}
          </button>
          {editing && (
            <button
              className={`c-btn c-btn--ghost${designOpen ? ' topbar__page--active' : ''}`}
              title={t('design.title')}
              data-tour-anchor="ui:design-button"
              onClick={() => setDesignOpen(!designOpen)}
            >
              🎨 {t('design.title')}
            </button>
          )}
          <button
            className="c-btn c-btn--ghost"
            title={t('focus.title')}
            data-tour-anchor="ui:focus-button"
            onClick={() => setFocusOpen(true)}
          >
            ◎ {t('focus.title')}
          </button>
          <button
            className={`c-btn c-btn--ghost${marketOpen ? ' topbar__page--active' : ''}`}
            title={t('market.title')}
            data-tour-anchor="ui:market-button"
            onClick={() => setMarketOpen(!marketOpen)}
          >
            ⊞ {t('market.title')}
          </button>
          <button
            className="c-btn c-btn--ghost"
            title={t('settings.title')}
            data-tour-anchor="ui:settings-button"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
      </header>

      <main className="app__canvas">
        {marketOpen ? <ToolMarket /> : <Canvas />}
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {designOpen && editing && <DesignPanel onClose={() => setDesignOpen(false)} />}
      {focusOpen && <FocusMode onClose={() => setFocusOpen(false)} />}
      {needsProfile && (
        <ProfileModal
          onDone={() => {
            if (!useAppStore.getState().onboardingDone) setShowTemplates(true);
          }}
        />
      )}
      {showTemplates && !needsProfile && (
        <TemplatePicker
          onDone={() => {
            setShowTemplates(false);
            startTour();
          }}
        />
      )}
      {tourActive && !needsProfile && !showTemplates && <Tour />}

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className="c-card toast">
            <div className="toast__text">
              <strong>{toast.title}</strong>
              {toast.body && <div className="c-muted">{toast.body}</div>}
            </div>
            {toast.onAction && (
              <button
                className="c-btn c-btn--primary toast__action"
                onClick={() => {
                  void toast.onAction?.();
                  setToasts((ts) => ts.filter((x) => x.id !== toast.id));
                }}
              >
                {toast.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

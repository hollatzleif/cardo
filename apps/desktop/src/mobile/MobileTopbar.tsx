import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/appStore';

/**
 * Phone top bar: brand, page picker and one ☰ button. Everything the desktop
 * spreads across the bar (edit, design, focus, tools, inbox, search,
 * settings) lives in a sheet, so it stays reachable with a thumb.
 */
export function MobileTopbar({
  inboxUnread,
  onOpenInbox,
}: {
  inboxUnread: number;
  onOpenInbox(): void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const pages = useAppStore((s) => s.pages);
  const currentPageId = useAppStore((s) => s.currentPageId);
  const selectPage = useAppStore((s) => s.selectPage);
  const addPage = useAppStore((s) => s.addPage);
  const editing = useAppStore((s) => s.editing);
  const setEditing = useAppStore((s) => s.setEditing);
  const setDesignOpen = useAppStore((s) => s.setDesignOpen);
  const setFocusOpen = useAppStore((s) => s.setFocusOpen);
  const marketOpen = useAppStore((s) => s.marketOpen);
  const setMarketOpen = useAppStore((s) => s.setMarketOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  const run = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };
  const backToBoard = settingsOpen || marketOpen;

  return (
    <header className="topbar topbar--phone">
      <span className="topbar__brand">{t('app.name')}</span>
      {backToBoard ? (
        <button
          className="c-btn c-btn--ghost topbar__back"
          onClick={() => {
            setSettingsOpen(false);
            setMarketOpen(false);
          }}
        >
          ‹ {t('mobile.backToBoard')}
        </button>
      ) : (
        <select
          className="c-input topbar__page-select"
          aria-label={t('mobile.page')}
          value={currentPageId}
          onChange={(e) => selectPage(e.target.value)}
        >
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </select>
      )}
      <button
        className="c-btn c-btn--ghost topbar__menu-button"
        aria-label={t('mobile.menu')}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        ☰{inboxUnread > 0 && <span className="topbar__inbox-badge">{inboxUnread}</span>}
      </button>
      {menuOpen && (
        <div className="mobile-sheet-backdrop" onClick={() => setMenuOpen(false)}>
          <nav className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <button className="c-btn mobile-sheet__item" onClick={run(() => setEditing(!editing))}>
              {editing ? t('mobile.doneEditing') : t('mobile.arrange')}
            </button>
            {editing && (
              <button className="c-btn mobile-sheet__item" onClick={run(() => void addPage())}>
                + {t('canvas.addPage')}
              </button>
            )}
            <button
              className="c-btn mobile-sheet__item"
              onClick={run(() => {
                setEditing(true);
                setDesignOpen(true);
              })}
            >
              🎨 {t('design.title')}
            </button>
            <button className="c-btn mobile-sheet__item" onClick={run(() => setFocusOpen(true))}>
              ◎ {t('focus.title')}
            </button>
            <button className="c-btn mobile-sheet__item" onClick={run(() => setPaletteOpen(true))}>
              ⌕ {t('mobile.search')}
            </button>
            <button className="c-btn mobile-sheet__item" onClick={run(onOpenInbox)}>
              ✉ {t('inbox.title')}
              {inboxUnread > 0 && <span className="topbar__inbox-badge">{inboxUnread}</span>}
            </button>
            <button
              className="c-btn mobile-sheet__item"
              onClick={run(() => {
                setSettingsOpen(false);
                setMarketOpen(true);
              })}
            >
              ⊞ {t('market.title')}
            </button>
            <button
              className="c-btn mobile-sheet__item"
              onClick={run(() => {
                setMarketOpen(false);
                setSettingsOpen(true);
              })}
            >
              ⚙ {t('settings.title')}
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}

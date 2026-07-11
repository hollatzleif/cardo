import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, PrivacyBadge } from '@cardo/ui';
import { liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';

type StatusFilter = 'all' | 'active' | 'inactive';
type PrivacyFilter = 'all' | 'green' | 'yellow';

/**
 * Tool market, phase 1: an activation catalog rendered as a full page
 * (not a modal). Every tool ships with the app; "installing" only
 * activates it. The privacy traffic light is shown for every tool BEFORE
 * activation (transparency principle). Search + filters scale ahead to
 * the phase-3 community market.
 */
export function ToolMarket() {
  const { t } = useTranslation();
  const activeToolIds = useAppStore((s) => s.activeToolIds);
  const setToolActive = useAppStore((s) => s.setToolActive);
  const setMarketOpen = useAppStore((s) => s.setMarketOpen);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [privacy, setPrivacy] = useState<PrivacyFilter>('all');

  const tools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...liveTools.values()].filter((tool) => {
      const active = activeToolIds.includes(tool.manifest.id);
      if (status === 'active' && !active) return false;
      if (status === 'inactive' && active) return false;
      if (privacy !== 'all' && tool.manifest.privacy.level !== privacy) return false;
      if (!q) return true;
      const haystack =
        `${t(tool.manifest.nameKey)} ${t(tool.manifest.descriptionKey)} ${tool.manifest.id}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, status, privacy, activeToolIds, t]);

  const statusOptions: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: t('market.filter.all') },
    { id: 'active', label: t('market.filter.active') },
    { id: 'inactive', label: t('market.filter.inactive') },
  ];
  const privacyOptions: Array<{ id: PrivacyFilter; label: string }> = [
    { id: 'all', label: t('market.filter.privacyAll') },
    { id: 'green', label: t('market.privacyBadge.green') },
    { id: 'yellow', label: t('market.privacyBadge.yellow') },
  ];

  return (
    <div className="market-page">
      <header className="market-page__header">
        <div>
          <h2>{t('market.title')}</h2>
          <p className="c-muted">{t('market.subtitle')}</p>
        </div>
        <Button variant="ghost" onClick={() => setMarketOpen(false)}>
          ← {t('market.back')}
        </Button>
      </header>

      <div className="market-page__controls">
        <Input
          className="c-input market-page__search"
          placeholder={t('market.search')}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="market-page__filters">
          {statusOptions.map((o) => (
            <button
              key={o.id}
              className={`c-btn c-btn--ghost market-page__chip${status === o.id ? ' market-page__chip--active' : ''}`}
              onClick={() => setStatus(o.id)}
            >
              {o.label}
            </button>
          ))}
          <span className="market-page__filter-sep" />
          {privacyOptions.map((o) => (
            <button
              key={o.id}
              className={`c-btn c-btn--ghost market-page__chip${privacy === o.id ? ' market-page__chip--active' : ''}`}
              onClick={() => setPrivacy(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {tools.length === 0 ? (
        <p className="c-muted market-page__empty">{t('market.noResults')}</p>
      ) : (
        <div className="market-page__grid">
          {tools.map((tool) => {
            const id = tool.manifest.id;
            const active = activeToolIds.includes(id);
            return (
              <div key={id} className="c-card market-page__item">
                <div
                  className="market-page__item-head"
                  title={t(`market.privacy.${tool.manifest.privacy.level}`)}
                >
                  <strong>{t(tool.manifest.nameKey)}</strong>
                  <PrivacyBadge
                    level={tool.manifest.privacy.level}
                    label={t(`market.privacyBadge.${tool.manifest.privacy.level}`)}
                  />
                </div>
                <p className="c-muted market-page__item-desc">
                  {t(tool.manifest.descriptionKey)}
                </p>
                <p className="c-muted market-page__item-privacy">
                  {t(tool.manifest.privacy.summaryKey)}
                </p>
                <div className="market-page__item-actions">
                  {active && <span className="market-page__active-badge">✓ {t('market.active')}</span>}
                  <button
                    className={`c-btn${active ? '' : ' c-btn--primary'}`}
                    onClick={() => void setToolActive(id, !active)}
                  >
                    {active ? t('market.deactivate') : t('market.activate')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Modal, PrivacyBadge } from '@cardo/ui';
import { liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';

/**
 * Tool market, phase 1: an activation catalog. Every tool ships with the
 * app; "installing" only activates it. The privacy traffic light is shown
 * for every tool BEFORE activation (transparency principle).
 */
export function ToolMarket({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const activeToolIds = useAppStore((s) => s.activeToolIds);
  const setToolActive = useAppStore((s) => s.setToolActive);

  return (
    <Modal onClose={onClose}>
      <div className="market">
        <header className="market__header">
          <h3>{t('market.title')}</h3>
          <p className="c-muted">{t('market.subtitle')}</p>
        </header>
        <div className="market__list">
          {[...liveTools.values()].map((tool) => {
            const id = tool.manifest.id;
            const active = activeToolIds.includes(id);
            return (
              <div key={id} className="c-card market__item">
                <div className="market__item-info">
                  <div className="market__item-title">
                    <strong>{t(tool.manifest.nameKey)}</strong>
                    <PrivacyBadge
                      level={tool.manifest.privacy.level}
                      label={t(`market.privacy.${tool.manifest.privacy.level}`)}
                    />
                  </div>
                  <div className="c-muted">{t(tool.manifest.descriptionKey)}</div>
                  <div className="c-muted market__item-privacy">
                    {t(tool.manifest.privacy.summaryKey)}
                  </div>
                </div>
                <button
                  className={`c-btn${active ? '' : ' c-btn--primary'}`}
                  onClick={() => void setToolActive(id, !active)}
                >
                  {active ? t('market.deactivate') : t('market.activate')}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

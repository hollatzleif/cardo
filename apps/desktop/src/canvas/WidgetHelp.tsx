import { useTranslation } from 'react-i18next';
import { Modal, PrivacyBadge, SetupGuide } from '@cardo/ui';
import { liveTools } from '../host/tools';

/**
 * Per-tool help modal: explains how the tool works, how to set it up and
 * which task areas it suits best. Content comes from the i18n convention
 * `tool.<id>.help.{how,setup,bestFor}`; tools with a manifest setup guide
 * additionally render the shared <SetupGuide>. The privacy summary is always
 * shown at the bottom – transparency everywhere.
 */
export function WidgetHelp({ toolId, onClose }: { toolId: string; onClose(): void }) {
  const { t } = useTranslation();
  const tool = liveTools.get(toolId);
  if (!tool) return null;
  const manifest = tool.manifest;

  return (
    <Modal onClose={onClose}>
      <div className="widget-help">
        <div className="widget-help__head">
          <h2 className="widget-help__title">{t(manifest.nameKey)}</h2>
          <button
            className="c-btn c-btn--ghost widget-help__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <section className="widget-help__section">
          <h3 className="widget-help__heading">{t('canvas.help.how')}</h3>
          <p className="widget-help__text">{t(`tool.${manifest.id}.help.how`)}</p>
        </section>

        <section className="widget-help__section">
          <h3 className="widget-help__heading">{t('canvas.help.setup')}</h3>
          <p className="widget-help__text">{t(`tool.${manifest.id}.help.setup`)}</p>
          {manifest.setupSteps.length > 0 && (
            <SetupGuide
              title={t('market.setupGuideTitle', { tool: t(manifest.nameKey) })}
              steps={manifest.setupSteps.map((step) => ({
                title: t(step.titleKey),
                body: t(step.bodyKey),
              }))}
            />
          )}
        </section>

        <section className="widget-help__section">
          <h3 className="widget-help__heading">{t('canvas.help.bestFor')}</h3>
          <p className="widget-help__text">{t(`tool.${manifest.id}.help.bestFor`)}</p>
        </section>

        <div className="widget-help__privacy">
          <PrivacyBadge
            level={manifest.privacy.level}
            label={t(`market.privacyBadge.${manifest.privacy.level}`)}
          />
          <p className="widget-help__text c-muted">{t(manifest.privacy.summaryKey)}</p>
        </div>
      </div>
    </Modal>
  );
}

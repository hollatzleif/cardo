import { useTranslation } from 'react-i18next';
import { Modal, PrivacyBadge } from '@cardo/ui';
import { liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';

/** Widget picker (edit mode). Shows every activated tool with its privacy label. */
export function AddWidgetMenu({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const addWidget = useAppStore((s) => s.addWidget);
  const activeToolIds = useAppStore((s) => s.activeToolIds);

  return (
    <Modal onClose={onClose}>
      <div className="add-widget-menu">
        <h3>{t('canvas.addWidget')}</h3>
        {[...liveTools.values()]
          .filter((tool) => activeToolIds.includes(tool.manifest.id))
          .map((tool) =>
          tool.manifest.widgets.map((decl) => (
            <button
              key={`${tool.manifest.id}:${decl.id}`}
              className="c-btn add-widget-menu__item"
              onClick={async () => {
                await addWidget(tool.manifest.id, decl.id, decl.defaultSize);
                onClose();
              }}
            >
              <span className="add-widget-menu__name">{t(tool.manifest.nameKey)}</span>
              <span className="c-muted add-widget-menu__desc">
                {t(tool.manifest.descriptionKey)}
              </span>
              <PrivacyBadge
                level={tool.manifest.privacy.level}
                label={t(`market.privacy.${tool.manifest.privacy.level}`)}
              />
            </button>
          )),
        )}
      </div>
    </Modal>
  );
}

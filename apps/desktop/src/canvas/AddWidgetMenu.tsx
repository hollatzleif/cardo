import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Modal, PrivacyBadge } from '@cardo/ui';
import { liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';

/** Widget picker (edit mode): searchable card grid of every active tool. */
export function AddWidgetMenu({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const addWidget = useAppStore((s) => s.addWidget);
  const activeToolIds = useAppStore((s) => s.activeToolIds);
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...liveTools.values()]
      .filter((tool) => activeToolIds.includes(tool.manifest.id))
      .flatMap((tool) => tool.manifest.widgets.map((decl) => ({ tool, decl })))
      .filter(({ tool }) => {
        if (!q) return true;
        return `${t(tool.manifest.nameKey)} ${t(tool.manifest.descriptionKey)} ${tool.manifest.id}`
          .toLowerCase()
          .includes(q);
      });
  }, [query, activeToolIds, t]);

  return (
    <Modal onClose={onClose}>
      <div className="add-widget">
        <header className="add-widget__header">
          <h3>{t('canvas.addWidget')}</h3>
          <Input
            className="c-input add-widget__search"
            placeholder={t('market.search')}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </header>
        {entries.length === 0 ? (
          <p className="c-muted add-widget__empty">{t('market.noResults')}</p>
        ) : (
          <div className="add-widget__grid">
            {entries.map(({ tool, decl }) => (
              <button
                key={`${tool.manifest.id}:${decl.id}`}
                className="add-widget__card"
                onClick={async () => {
                  await addWidget(tool.manifest.id, decl.id, decl.defaultSize);
                  onClose();
                }}
              >
                <span
                  className="add-widget__card-head"
                  title={t(`market.privacy.${tool.manifest.privacy.level}`)}
                >
                  <span className="add-widget__name">{t(tool.manifest.nameKey)}</span>
                  <PrivacyBadge
                    level={tool.manifest.privacy.level}
                    label={t(`market.privacyBadge.${tool.manifest.privacy.level}`)}
                  />
                </span>
                <span className="c-muted add-widget__desc">
                  {t(tool.manifest.descriptionKey)}
                </span>
                <span className="add-widget__add">+ {t('canvas.addWidget')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

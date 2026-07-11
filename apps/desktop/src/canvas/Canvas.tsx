import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/appStore';
import { LayoutEngine } from './LayoutEngine';
import { WidgetFrame } from './WidgetFrame';
import { AddWidgetMenu } from './AddWidgetMenu';

export function Canvas() {
  const { t } = useTranslation();
  const editing = useAppStore((s) => s.editing);
  const pages = useAppStore((s) => s.pages);
  const currentPageId = useAppStore((s) => s.currentPageId);
  const updateWidgetPositions = useAppStore((s) => s.updateWidgetPositions);
  const removeWidget = useAppStore((s) => s.removeWidget);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return null;

  const shortcut = navigator.platform.includes('Mac') ? '⌘E' : 'Ctrl+E';

  return (
    <div className="canvas">
      {page.widgets.length === 0 && !editing && (
        <div className="canvas__empty c-muted">{t('canvas.emptyHint', { shortcut })}</div>
      )}
      <LayoutEngine
        widgets={page.widgets}
        editing={editing}
        onPositionsChange={(updates) => void updateWidgetPositions(updates)}
        renderWidget={(widget) => (
          <WidgetFrame
            widget={widget}
            editing={editing}
            onRemove={() => void removeWidget(widget.instanceId)}
          />
        )}
      />
      {editing && (
        <button
          className="c-btn c-btn--primary canvas__add-button"
          data-tour-anchor="ui:add-widget"
          onClick={() => setAddMenuOpen(true)}
        >
          + {t('canvas.addWidget')}
        </button>
      )}
      {addMenuOpen && <AddWidgetMenu onClose={() => setAddMenuOpen(false)} />}
    </div>
  );
}

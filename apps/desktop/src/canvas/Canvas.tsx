import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/appStore';
import { LayoutEngine } from './LayoutEngine';
import { WidgetFrame } from './WidgetFrame';
import { AddWidgetMenu } from './AddWidgetMenu';
import { MobileBoard } from './MobileBoard';
import { useIsPhone } from '../mobile/viewport';
import { swipeAllowedFrom, swipeDirection } from '../mobile/swipe';

export function Canvas() {
  const { t } = useTranslation();
  const editing = useAppStore((s) => s.editing);
  const pages = useAppStore((s) => s.pages);
  const currentPageId = useAppStore((s) => s.currentPageId);
  const updateWidgetPositions = useAppStore((s) => s.updateWidgetPositions);
  const removeWidget = useAppStore((s) => s.removeWidget);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const isPhone = useIsPhone();
  const selectPage = useAppStore((s) => s.selectPage);
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return null;

  const shortcut = navigator.platform.includes('Mac') ? '⌘E' : 'Ctrl+E';
  const emptyHint = isPhone ? t('canvas.emptyHintPhone') : t('canvas.emptyHint', { shortcut });

  const sorted = [...pages].sort((a, b) => a.order - b.order);
  const swipeHandlers =
    isPhone && !editing && sorted.length > 1
      ? {
          onTouchStart: (e: React.TouchEvent) => {
            const t = e.touches[0];
            touchStart.current =
              t && e.touches.length === 1 && swipeAllowedFrom(e.target)
                ? { x: t.clientX, y: t.clientY, t: e.timeStamp }
                : null;
          },
          onTouchEnd: (e: React.TouchEvent) => {
            const start = touchStart.current;
            touchStart.current = null;
            const t = e.changedTouches[0];
            if (!start || !t) return;
            const dir = swipeDirection(
              t.clientX - start.x,
              t.clientY - start.y,
              e.timeStamp - start.t,
            );
            if (dir === 0) return;
            const index = sorted.findIndex((p) => p.id === currentPageId);
            const next = sorted[index + dir];
            if (next) selectPage(next.id);
          },
        }
      : {};

  return (
    <div className="canvas" {...swipeHandlers}>
      {page.widgets.length === 0 && !editing && (
        <div className="canvas__empty c-muted">{emptyHint}</div>
      )}
      {isPhone ? (
        <MobileBoard
          widgets={page.widgets}
          editing={editing}
          onPositionsChange={(updates) => void updateWidgetPositions(updates)}
          onRemove={(instanceId) => void removeWidget(instanceId)}
        />
      ) : (
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
      )}
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

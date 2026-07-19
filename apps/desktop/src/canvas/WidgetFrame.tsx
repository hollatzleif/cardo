import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { widgetAccentStyle } from '@cardo/ui';
import { useAppStore, type WidgetInstance } from '../state/appStore';
import { liveTools } from '../host/tools';
import { WidgetHelp } from './WidgetHelp';
import { GRID_COLS, GRID_MARGIN } from './LayoutEngine';

type GridPos = { x: number; y: number; w: number; h: number };

/**
 * Pointer-event drag for a widget's move and resize grips. We roll our own
 * instead of using react-grid-layout's react-draggable: in the desktop WebView
 * a trackpad drag is taken as a text-selection gesture and the mousemove events
 * react-draggable relies on never arrive, so RGL's move/resize silently do
 * nothing. Pointer events + setPointerCapture are reliable everywhere. Grid
 * geometry (column/row pitch) is derived live from the grid-item element, so it
 * works at any container width.
 */
function beginGridDrag(
  e: React.PointerEvent,
  widget: WidgetInstance,
  mode: 'move' | 'resize',
  min: { w: number; h: number },
  commit: (pos: GridPos) => void,
): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget as HTMLElement;
  const item = grip.closest('.react-grid-item') as HTMLElement | null;
  if (!item) return;
  grip.setPointerCapture(e.pointerId);

  const startX = e.clientX;
  const startY = e.clientY;
  const pitchX = (item.offsetWidth + GRID_MARGIN) / widget.w;
  const pitchY = (item.offsetHeight + GRID_MARGIN) / widget.h;
  let last: GridPos = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

  const onMove = (ev: PointerEvent): void => {
    const dCol = Math.round((ev.clientX - startX) / pitchX);
    const dRow = Math.round((ev.clientY - startY) / pitchY);
    const next: GridPos =
      mode === 'move'
        ? {
            x: Math.max(0, Math.min(GRID_COLS - widget.w, widget.x + dCol)),
            y: Math.max(0, widget.y + dRow),
            w: widget.w,
            h: widget.h,
          }
        : {
            x: widget.x,
            y: widget.y,
            w: Math.max(min.w, Math.min(GRID_COLS - widget.x, widget.w + dCol)),
            h: Math.max(min.h, widget.h + dRow),
          };
    if (next.x !== last.x || next.y !== last.y || next.w !== last.w || next.h !== last.h) {
      last = next;
      commit(next);
    }
  };
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export function WidgetFrame({
  widget,
  editing,
  onRemove,
}: {
  widget: WidgetInstance;
  editing: boolean;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const setWidgetVariant = useAppStore((s) => s.setWidgetVariant);
  const updateWidgetPositions = useAppStore((s) => s.updateWidgetPositions);
  const [helpOpen, setHelpOpen] = useState(false);
  const tool = liveTools.get(widget.toolId);
  if (!tool) {
    return <div className="c-card widget-frame widget-frame--missing">?</div>;
  }
  const Widget = tool.Widget;
  const decl = tool.manifest.widgets.find((d) => d.id === widget.widgetId);
  const variants = decl?.variants ?? [];
  const min = { w: decl?.minSize.w ?? 1, h: decl?.minSize.h ?? 1 };
  const commit = (pos: GridPos): void => {
    void updateWidgetPositions([{ instanceId: widget.instanceId, ...pos }]);
  };

  const helpButton = (floating: boolean) => (
    <button
      className={`c-btn c-btn--ghost widget-frame__help${floating ? ' widget-frame__help--floating' : ''}`}
      aria-label={t('canvas.widgetHelp')}
      title={t('canvas.widgetHelp')}
      onClick={() => setHelpOpen(true)}
    >
      ?
    </button>
  );

  return (
    <div
      className={`c-card widget-frame${editing ? ' widget-frame--editing' : ''}`}
      style={widgetAccentStyle(widget.accentToken)}
      data-tour-anchor={`widget:${widget.toolId}:${widget.widgetId}`}
    >
      {!editing && helpButton(true)}
      {editing && (
        <div className="widget-frame__toolbar">
          {helpButton(false)}
          <span className="widget-frame__title">{t(tool.manifest.nameKey)}</span>
          <span
            className="widget-frame__drag"
            role="button"
            aria-label={t('canvas.moveWidget')}
            title={t('canvas.moveWidget')}
            onPointerDown={(e) => beginGridDrag(e, widget, 'move', min, commit)}
          >
            ⠿
          </span>
          {variants.length > 1 && (
            <select
              className="c-input widget-frame__variant"
              value={widget.variant ?? variants[0]}
              title={t('canvas.widgetVariant')}
              onChange={(e) => void setWidgetVariant(widget.instanceId, e.target.value)}
            >
              {variants.map((v) => (
                <option key={v} value={v}>
                  {t(`tool.${widget.toolId}.variant.${v}`, { defaultValue: v })}
                </option>
              ))}
            </select>
          )}
          <button
            className="c-btn c-btn--ghost widget-frame__remove"
            title={t('canvas.removeWidget')}
            onClick={onRemove}
          >
            ✕
          </button>
        </div>
      )}
      <div className="widget-body">
        <Widget
          instanceId={widget.instanceId}
          widgetId={widget.widgetId}
          variant={widget.variant}
          size={{ w: widget.w, h: widget.h }}
          editing={editing}
        />
      </div>
      {editing && (
        <span
          className="widget-frame__resize"
          role="button"
          aria-label={t('canvas.resizeWidget')}
          title={t('canvas.resizeWidget')}
          onPointerDown={(e) => beginGridDrag(e, widget, 'resize', min, commit)}
        />
      )}
      {helpOpen && <WidgetHelp toolId={widget.toolId} onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

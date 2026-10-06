import type { WidgetInstance } from '../state/appStore';
import { liveTools } from '../host/tools';
import { useGridGutter } from '../design/design';
import { ROW_HEIGHT } from './LayoutEngine';
import { WidgetFrame } from './WidgetFrame';
import {
  moveInPhoneOrder,
  phoneCardHeight,
  phoneOrder,
  phoneWidgetCols,
  resizeInPhone,
  type PositionUpdate,
  PHONE_MIN_ROWS_CAP,
} from '../mobile/mobileLayout';

/**
 * Single-column board for phone-width screens. Same widgets, same stored
 * positions – read top-to-bottom as a list. Arranging uses ↑ ↓ − + buttons
 * instead of drag grips, which are unusable with a thumb.
 */
export function MobileBoard({
  widgets,
  editing,
  onPositionsChange,
  onRemove,
}: {
  widgets: WidgetInstance[];
  editing: boolean;
  onPositionsChange(updates: PositionUpdate[]): void;
  onRemove(instanceId: string): void;
}) {
  const gutter = useGridGutter();
  const ordered = phoneOrder(widgets);

  return (
    <div className="mobile-board" style={{ gap: gutter }}>
      {ordered.map((widget, index) => {
        const decl = liveTools
          .get(widget.toolId)
          ?.manifest.widgets.find((d) => d.id === widget.widgetId);
        const minH = decl?.minSize.h ?? 1;
        const minW = decl?.minSize.w ?? 1;
        return (
          <div
            key={widget.instanceId}
            className="mobile-board__item"
            // Cards grow with their content (no scroll boxes inside a
            // scrolling page); the stored height is only the minimum, capped
            // so empty widgets stay compact.
            style={{
              minHeight: phoneCardHeight(
                Math.min(widget.h, PHONE_MIN_ROWS_CAP),
                ROW_HEIGHT,
                gutter,
                minH,
              ),
            }}
          >
            <WidgetFrame
              widget={widget}
              editing={editing}
              onRemove={() => onRemove(widget.instanceId)}
              mobile={{
                cols: phoneWidgetCols(minW),
                canMoveUp: index > 0,
                canMoveDown: index < ordered.length - 1,
                onMove: (direction) => {
                  const updates = moveInPhoneOrder(widgets, widget.instanceId, direction);
                  if (updates.length > 0) onPositionsChange(updates);
                },
                onResize: (delta) => {
                  const update = resizeInPhone(widget, delta, minH);
                  if (update) onPositionsChange([update]);
                },
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

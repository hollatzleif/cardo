import { useMemo } from 'react';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import type { ReactNode } from 'react';
import type { WidgetInstance } from '../state/appStore';
import { liveTools } from '../host/tools';

/**
 * LayoutEngine – thin abstraction over react-grid-layout.
 * Everything outside this file talks in WidgetInstance terms only, so the
 * grid library can be swapped for a custom engine without touching the app.
 */

const Grid = WidthProvider(RGL);

export const GRID_COLS = 12;
const ROW_HEIGHT = 56;

export interface LayoutEngineProps {
  widgets: WidgetInstance[];
  editing: boolean;
  onPositionsChange(
    updates: Array<{ instanceId: string; x: number; y: number; w: number; h: number }>,
  ): void;
  renderWidget(widget: WidgetInstance): ReactNode;
}

export function LayoutEngine({ widgets, editing, onPositionsChange, renderWidget }: LayoutEngineProps) {
  const layout: Layout[] = useMemo(
    () =>
      widgets.map((w) => {
        const decl = liveTools
          .get(w.toolId)
          ?.manifest.widgets.find((d) => d.id === w.widgetId);
        return {
          i: w.instanceId,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: decl?.minSize.w ?? 1,
          minH: decl?.minSize.h ?? 1,
          static: !editing,
        };
      }),
    [widgets, editing],
  );

  return (
    <Grid
      className="canvas-grid"
      layout={layout}
      cols={GRID_COLS}
      rowHeight={ROW_HEIGHT}
      margin={[12, 12]}
      isDraggable={editing}
      isResizable={editing}
      compactType="vertical"
      draggableCancel=".widget-body"
      onLayoutChange={(next: Layout[]) => {
        if (!editing) return;
        const updates = next
          .map((l) => ({ instanceId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }))
          .filter((u) => {
            const current = widgets.find((w) => w.instanceId === u.instanceId);
            return (
              current &&
              (current.x !== u.x || current.y !== u.y || current.w !== u.w || current.h !== u.h)
            );
          });
        if (updates.length > 0) onPositionsChange(updates);
      }}
    >
      {widgets.map((w) => (
        <div key={w.instanceId}>{renderWidget(w)}</div>
      ))}
    </Grid>
  );
}

import { useTranslation } from 'react-i18next';
import { widgetAccentStyle } from '@cardo/ui';
import type { WidgetInstance } from '../state/appStore';
import { liveTools } from '../host/tools';

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
  const tool = liveTools.get(widget.toolId);
  if (!tool) {
    return <div className="c-card widget-frame widget-frame--missing">?</div>;
  }
  const Widget = tool.Widget;

  return (
    <div
      className={`c-card widget-frame${editing ? ' widget-frame--editing' : ''}`}
      style={widgetAccentStyle(widget.accentToken)}
      data-tour-anchor={`widget:${widget.toolId}:${widget.widgetId}`}
    >
      {editing && (
        <div className="widget-frame__toolbar">
          <span className="widget-frame__title">{t(tool.manifest.nameKey)}</span>
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
          size={{ w: widget.w, h: widget.h }}
          editing={editing}
        />
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { widgetAccentStyle } from '@cardo/ui';
import { useAppStore, type WidgetInstance } from '../state/appStore';
import { liveTools } from '../host/tools';
import { WidgetHelp } from './WidgetHelp';

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
  const [helpOpen, setHelpOpen] = useState(false);
  const tool = liveTools.get(widget.toolId);
  if (!tool) {
    return <div className="c-card widget-frame widget-frame--missing">?</div>;
  }
  const Widget = tool.Widget;
  const variants =
    tool.manifest.widgets.find((d) => d.id === widget.widgetId)?.variants ?? [];

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
      {helpOpen && <WidgetHelp toolId={widget.toolId} onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

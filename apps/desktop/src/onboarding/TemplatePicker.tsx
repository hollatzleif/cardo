import { useTranslation } from 'react-i18next';
import { Button, Modal } from '@cardo/ui';
import { useAppStore, type WidgetInstance } from '../state/appStore';

type TemplateWidget = Omit<WidgetInstance, 'instanceId'>;

interface Template {
  id: string;
  emoji: string;
  widgets: TemplateWidget[];
}

/**
 * Starter layouts for the first dashboard: pick one, everything stays
 * freely rearrangeable afterwards. Templates only reference tools that
 * are active by default.
 */
const TEMPLATES: Template[] = [
  {
    id: 'work',
    emoji: '💼',
    widgets: [
      { toolId: 'today', widgetId: 'main', x: 0, y: 0, w: 4, h: 7 },
      { toolId: 'todo', widgetId: 'main', x: 4, y: 0, w: 4, h: 7 },
      { toolId: 'calendar', widgetId: 'main', x: 8, y: 0, w: 4, h: 7 },
      { toolId: 'pomodoro', widgetId: 'main', x: 0, y: 7, w: 4, h: 5 },
      { toolId: 'workclock', widgetId: 'main', x: 4, y: 7, w: 4, h: 5 },
      { toolId: 'quickcapture', widgetId: 'main', x: 8, y: 7, w: 4, h: 5 },
    ],
  },
  {
    id: 'private',
    emoji: '🏡',
    widgets: [
      { toolId: 'today', widgetId: 'main', x: 0, y: 0, w: 5, h: 7 },
      { toolId: 'routine', widgetId: 'main', x: 5, y: 0, w: 4, h: 5 },
      { toolId: 'habits', widgetId: 'main', x: 0, y: 7, w: 6, h: 6 },
      { toolId: 'countdown', widgetId: 'main', x: 9, y: 0, w: 3, h: 3 },
      { toolId: 'clock', widgetId: 'main', x: 9, y: 3, w: 3, h: 3 },
      { toolId: 'notes', widgetId: 'main', x: 5, y: 5, w: 7, h: 6 },
    ],
  },
  {
    id: 'focus',
    emoji: '🎯',
    widgets: [
      { toolId: 'pomodoro', widgetId: 'main', x: 0, y: 0, w: 4, h: 6 },
      { toolId: 'todo', widgetId: 'board', x: 4, y: 0, w: 8, h: 7 },
      { toolId: 'workclock', widgetId: 'main', x: 0, y: 6, w: 4, h: 4 },
      { toolId: 'stats', widgetId: 'main', x: 4, y: 7, w: 8, h: 4 },
    ],
  },
];

export function TemplatePicker({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const applyTemplate = useAppStore((s) => s.applyTemplate);

  return (
    <Modal onClose={onDone}>
      <div className="templates">
        <h3>{t('onboarding.templates.title')}</h3>
        <p className="c-muted">{t('onboarding.templates.subtitle')}</p>
        <div className="templates__grid">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              className="templates__card"
              onClick={async () => {
                await applyTemplate(template.widgets);
                onDone();
              }}
            >
              <span className="templates__emoji">{template.emoji}</span>
              <strong>{t(`onboarding.templates.${template.id}.title`)}</strong>
              <span className="c-muted">{t(`onboarding.templates.${template.id}.body`)}</span>
            </button>
          ))}
        </div>
        <div className="templates__footer">
          <Button variant="ghost" onClick={onDone}>
            {t('onboarding.templates.blank')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

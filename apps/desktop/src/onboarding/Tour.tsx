import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import { liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';

export interface TourStep {
  /** data-tour-anchor value; undefined = centered card without spotlight */
  anchor?: string;
  titleKey: string;
  bodyKey: string;
}

/** Core steps; tool steps from manifests are appended for anchors that exist. */
const CORE_STEPS: TourStep[] = [
  { titleKey: 'onboarding.step.welcome.title', bodyKey: 'onboarding.step.welcome.body' },
  {
    anchor: 'ui:edit-toggle',
    titleKey: 'onboarding.step.edit.title',
    bodyKey: 'onboarding.step.edit.body',
  },
  {
    anchor: 'ui:settings-button',
    titleKey: 'onboarding.step.settings.title',
    bodyKey: 'onboarding.step.settings.body',
  },
  {
    anchor: 'ui:market-button',
    titleKey: 'onboarding.step.market.title',
    bodyKey: 'onboarding.step.market.body',
  },
  { titleKey: 'onboarding.step.palette.title', bodyKey: 'onboarding.step.palette.body' },
  { titleKey: 'onboarding.step.privacy.title', bodyKey: 'onboarding.step.privacy.body' },
];

function findAnchor(anchor?: string): DOMRect | null {
  if (!anchor) return null;
  const el = document.querySelector(`[data-tour-anchor="${anchor}"]`);
  return el ? el.getBoundingClientRect() : null;
}

/**
 * Interactive onboarding: overlay with a spotlight on real UI elements.
 * Skippable in EVERY step (prominent button), restartable from settings.
 * Tools contribute their own steps via the manifest; steps whose anchor
 * is not currently in the DOM are skipped automatically.
 */
export function Tour() {
  const { t } = useTranslation();
  const activeToolIds = useAppStore((s) => s.activeToolIds);
  const endTour = useAppStore((s) => s.endTour);
  const [index, setIndex] = useState(0);
  const [, forceTick] = useState(0);

  const steps = useMemo(() => {
    const toolSteps: TourStep[] = [];
    for (const tool of liveTools.values()) {
      if (!activeToolIds.includes(tool.manifest.id)) continue;
      for (const s of tool.manifest.tourSteps) {
        toolSteps.push({ anchor: s.anchor, titleKey: s.titleKey, bodyKey: s.bodyKey });
      }
    }
    // Tool steps only make sense when their widget is on the canvas.
    return [...CORE_STEPS, ...toolSteps.filter((s) => findAnchor(s.anchor) !== null)];
  }, [activeToolIds]);

  // Re-measure on resize so the spotlight follows its anchor.
  useEffect(() => {
    const onResize = () => forceTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const step = steps[index];
  if (!step) return null;
  const rect = findAnchor(step.anchor);
  const last = index === steps.length - 1;

  const PAD = 6;
  const cardStyle: React.CSSProperties = rect
    ? rect.top > window.innerHeight / 2
      ? { left: Math.min(rect.left, window.innerWidth - 360), bottom: window.innerHeight - rect.top + PAD * 2 }
      : { left: Math.min(rect.left, window.innerWidth - 360), top: rect.bottom + PAD * 2 }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="tour">
      {/* The spotlight's huge box-shadow is the scrim; the plain backdrop
          only covers anchor-less (centered) steps. */}
      {!rect && <div className="tour__backdrop" />}
      {rect && (
        <div
          className="tour__spotlight"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
          }}
        />
      )}
      <div className="c-card tour__card" style={cardStyle}>
        <strong>{t(step.titleKey)}</strong>
        <p>{t(step.bodyKey)}</p>
        <div className="tour__controls">
          <Button variant="ghost" onClick={() => void endTour()}>
            {t('onboarding.skip')}
          </Button>
          <span className="c-muted tour__progress">
            {index + 1}/{steps.length}
          </span>
          {index > 0 && (
            <Button variant="ghost" onClick={() => setIndex(index - 1)}>
              {t('onboarding.back')}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => (last ? void endTour() : setIndex(index + 1))}
          >
            {last ? t('onboarding.done') : t('onboarding.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}

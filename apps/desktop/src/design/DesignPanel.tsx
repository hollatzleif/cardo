import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@cardo/ui';
import {
  applyDesign,
  currentTokenHex,
  loadAndApplyStoredDesign,
  saveDesign,
  BACKGROUND_FITS,
  DENSITIES,
  FONT_PRESETS,
  type BackgroundFit,
  type Density,
  type DesignOverrides,
  type FontPreset,
} from './design';
import './design.css';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 300;

/** Color fields → the token whose live value seeds the color input. */
const COLOR_FIELDS = [
  { field: 'accent', token: '--accent', labelKey: 'design.colors.accent' },
  { field: 'bgCanvas', token: '--bg-canvas', labelKey: 'design.colors.canvas' },
  // Widget base color is read from the palette primitive because --bg-widget
  // may currently resolve to a color-mix() when transparency is active.
  { field: 'bgWidget', token: '--palette-surface-0', labelKey: 'design.colors.widget' },
  { field: 'textPrimary', token: '--text-primary', labelKey: 'design.colors.text' },
  { field: 'borderSubtle', token: '--border-subtle', labelKey: 'design.colors.border' },
] as const;

type ColorField = (typeof COLOR_FIELDS)[number]['field'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="design-section">
      <h4 className="design-section__title">{title}</h4>
      {children}
    </section>
  );
}

export function DesignPanel({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<DesignOverrides>({});
  const [bgError, setBgError] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<DesignOverrides | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAndApplyStoredDesign().then((stored) => {
      if (alive) setD(stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* Flush a pending debounced save when the drawer unmounts. */
  useEffect(
    () => () => {
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      if (pendingSave.current) void saveDesign(pendingSave.current);
    },
    [],
  );

  const scheduleSave = (next: DesignOverrides): void => {
    pendingSave.current = next;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      pendingSave.current = null;
      void saveDesign(next);
    }, SAVE_DEBOUNCE_MS);
  };

  /** Merge a patch (undefined values delete the field), apply live, persist. */
  const update = (patch: Partial<DesignOverrides>): void => {
    const next: DesignOverrides = { ...d, ...patch };
    for (const key of Object.keys(patch) as (keyof DesignOverrides)[]) {
      if (patch[key] === undefined) delete next[key];
    }
    applyDesign(next);
    setD(next);
    scheduleSave(next);
  };

  const resetAll = (): void => {
    const next: DesignOverrides = {};
    applyDesign(next);
    setD(next);
    setBgError(false);
    scheduleSave(next);
  };

  const onPickImage = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setBgError(true);
      return;
    }
    setBgError(false);
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      if (typeof url === 'string') update({ bgImage: url });
    };
    reader.readAsDataURL(file);
  };

  const colorValue = (field: ColorField, token: string): string =>
    d[field] ?? currentTokenHex(token);

  return (
    <aside className="design-panel" role="dialog" aria-label={t('design.title')}>
      <header className="design-panel__header">
        <h3 className="design-panel__title">{t('design.title')}</h3>
        <Button variant="ghost" aria-label={t('design.close')} onClick={onClose}>
          ✕
        </Button>
      </header>

      <Section title={t('design.typography.title')}>
        <label className="design-row">
          <span className="design-row__label">{t('design.typography.preset')}</span>
          <select
            className="c-input"
            value={d.fontPreset ?? 'system'}
            onChange={(e) => {
              const preset = e.target.value as FontPreset;
              update({ fontPreset: preset === 'system' ? undefined : preset });
            }}
          >
            {FONT_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t(`design.typography.presetOption.${preset}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="design-row">
          <span className="design-row__label">{t('design.typography.customFont')}</span>
          <Input
            value={d.fontFamily ?? ''}
            placeholder={t('design.typography.customFontPlaceholder')}
            onChange={(e) => update({ fontFamily: e.target.value || undefined })}
          />
        </label>
        <label className="design-row">
          <span className="design-row__label">
            {t('design.typography.fontSize')}
            <span className="design-row__value">{d.fontScale ?? 100}%</span>
          </span>
          <input
            type="range"
            className="design-slider"
            min={80}
            max={125}
            step={1}
            value={d.fontScale ?? 100}
            onChange={(e) => {
              const value = Number(e.target.value);
              update({ fontScale: value === 100 ? undefined : value });
            }}
          />
        </label>
      </Section>

      <Section title={t('design.colors.title')}>
        {COLOR_FIELDS.map(({ field, token, labelKey }) => (
          <div key={field} className="design-color-row">
            <span className="design-row__label">{t(labelKey)}</span>
            <input
              type="color"
              className="design-color-input"
              value={colorValue(field, token)}
              onChange={(e) => update({ [field]: e.target.value })}
            />
            <Button
              variant="ghost"
              className="design-color-reset"
              aria-label={t('design.colors.resetColor')}
              title={t('design.colors.resetColor')}
              disabled={d[field] === undefined}
              onClick={() => update({ [field]: undefined })}
            >
              ✕
            </Button>
          </div>
        ))}
      </Section>

      <Section title={t('design.background.title')}>
        <div className="design-row design-row--inline">
          <label className="c-btn design-file-button">
            <input
              type="file"
              accept="image/*"
              className="design-file-input"
              onChange={onPickImage}
            />
            {t('design.background.choose')}
          </label>
          {d.bgImage && (
            <Button
              variant="ghost"
              onClick={() =>
                update({ bgImage: undefined, bgFit: undefined, bgDim: undefined, bgBlur: undefined })
              }
            >
              {t('design.background.remove')}
            </Button>
          )}
        </div>
        {bgError && <p className="design-error">{t('design.background.tooLarge')}</p>}
        {d.bgImage && (
          <>
            <div
              className="design-bg-preview"
              style={{ backgroundImage: `url("${d.bgImage}")` }}
              aria-hidden="true"
            />
            <label className="design-row">
              <span className="design-row__label">{t('design.background.fit')}</span>
              <select
                className="c-input"
                value={d.bgFit ?? 'cover'}
                onChange={(e) => {
                  const fit = e.target.value as BackgroundFit;
                  update({ bgFit: fit === 'cover' ? undefined : fit });
                }}
              >
                {BACKGROUND_FITS.map((fit) => (
                  <option key={fit} value={fit}>
                    {t(`design.background.fitOption.${fit}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="design-row">
              <span className="design-row__label">
                {t('design.background.dim')}
                <span className="design-row__value">{d.bgDim ?? 0}%</span>
              </span>
              <input
                type="range"
                className="design-slider"
                min={0}
                max={60}
                step={1}
                value={d.bgDim ?? 0}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  update({ bgDim: value === 0 ? undefined : value });
                }}
              />
            </label>
            <label className="design-row">
              <span className="design-row__label">
                {t('design.background.blur')}
                <span className="design-row__value">{d.bgBlur ?? 0}px</span>
              </span>
              <input
                type="range"
                className="design-slider"
                min={0}
                max={12}
                step={1}
                value={d.bgBlur ?? 0}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  update({ bgBlur: value === 0 ? undefined : value });
                }}
              />
            </label>
          </>
        )}
      </Section>

      <Section title={t('design.widgets.title')}>
        <label className="design-row">
          <span className="design-row__label">
            {t('design.widgets.radius')}
            <span className="design-row__value">{d.radius ?? 10}px</span>
          </span>
          <input
            type="range"
            className="design-slider"
            min={0}
            max={24}
            step={1}
            value={d.radius ?? 10}
            onChange={(e) => update({ radius: Number(e.target.value) })}
          />
        </label>
        <label className="design-row">
          <span className="design-row__label">
            {t('design.widgets.transparency')}
            <span className="design-row__value">{d.widgetAlpha ?? 0}%</span>
          </span>
          <input
            type="range"
            className="design-slider"
            min={0}
            max={40}
            step={1}
            value={d.widgetAlpha ?? 0}
            onChange={(e) => {
              const value = Number(e.target.value);
              update({ widgetAlpha: value === 0 ? undefined : value });
            }}
          />
        </label>
        <label className="design-check">
          <input
            type="checkbox"
            checked={d.shadow ?? true}
            onChange={(e) => update({ shadow: e.target.checked ? undefined : false })}
          />
          {t('design.widgets.shadow')}
        </label>
        <label className="design-check">
          <input
            type="checkbox"
            checked={d.border ?? true}
            onChange={(e) => update({ border: e.target.checked ? undefined : false })}
          />
          {t('design.widgets.border')}
        </label>
      </Section>

      <Section title={t('design.layout.title')}>
        <label className="design-row">
          <span className="design-row__label">{t('design.layout.density')}</span>
          <select
            className="c-input"
            value={d.density ?? 'normal'}
            onChange={(e) => {
              const density = e.target.value as Density;
              update({ density: density === 'normal' ? undefined : density });
            }}
          >
            {DENSITIES.map((density) => (
              <option key={density} value={density}>
                {t(`design.layout.densityOption.${density}`)}
              </option>
            ))}
          </select>
        </label>
      </Section>

      <Section title={t('design.reset.title')}>
        <Button variant="danger" onClick={resetAll}>
          {t('design.reset.all')}
        </Button>
        <p className="c-muted design-hint">{t('design.reset.hint')}</p>
      </Section>
    </aside>
  );
}

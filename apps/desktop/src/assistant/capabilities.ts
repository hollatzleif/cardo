import { themes } from '@cardo/themes';
import { FONT_PRESETS, DENSITIES } from '../design/design';

/**
 * Live capability facts assembled from the app's own registries (theme list,
 * design engine) at prompt-assembly time — deliberately NOT hardcoded. A
 * future update that adds a theme or a design option surfaces to the
 * assistant automatically, with nothing to maintain in the system prompt.
 */
export interface Capabilities {
  /** Human-readable theme labels incl. light/dark. */
  themes: string[];
  /** Human-readable lines describing what the design engine can change. */
  design: string[];
}

export function buildCapabilities(
  t: (key: string) => string,
  language: string,
): Capabilities {
  const de = language === 'de';
  const appearanceWord = (a: string) =>
    a === 'light' ? (de ? 'hell' : 'light') : de ? 'dunkel' : 'dark';

  const themeLabels = themes.map(
    (theme) => `${t(theme.nameKey)} (${appearanceWord(theme.appearance)})`,
  );

  const fonts = FONT_PRESETS.join(', ');
  const densities = DENSITIES.join(', ');
  const design = de
    ? [
        `Im Erscheinungsbild anpassbar: Schriftart (${fonts}), Dichte (${densities}), ` +
          `Ecken-Radius, Widget-Schatten und -Rahmen, Hintergrundbild/-farbe und Akzentfarbe. ` +
          `Jede Einstellung bleibt frei wählbar – Cardo erzwingt keinen Look.`,
      ]
    : [
        `Customizable under Appearance: font (${fonts}), density (${densities}), ` +
          `corner radius, widget shadow and border, background image/color and accent color. ` +
          `Every setting stays freely selectable — Cardo never forces a look.`,
      ];

  return { themes: themeLabels, design };
}

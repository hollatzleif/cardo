import { describe, expect, it } from 'vitest';
import { themes } from '@cardo/themes';
import { FONT_PRESETS } from '../design/design';
import { buildCapabilities } from './capabilities';

describe('buildCapabilities', () => {
  const t = (key: string) => `T(${key})`;

  it('lists EVERY installed theme — derived live, not hardcoded', () => {
    const caps = buildCapabilities(t, 'de');
    // One label per theme in the registry: adding a theme grows this for free.
    expect(caps.themes).toHaveLength(themes.length);
    for (const theme of themes) {
      expect(caps.themes.some((label) => label.startsWith(`T(${theme.nameKey})`))).toBe(true);
    }
    // Appearance is surfaced so the assistant can answer "hell oder dunkel?".
    expect(caps.themes.some((l) => l.includes('(dunkel)'))).toBe(true);
    expect(caps.themes.some((l) => l.includes('(hell)'))).toBe(true);
  });

  it('describes the design engine from its constants', () => {
    const caps = buildCapabilities(t, 'de');
    expect(caps.design).toHaveLength(1);
    // Every font preset the engine offers appears in the description.
    for (const preset of FONT_PRESETS) {
      expect(caps.design[0]).toContain(preset);
    }
  });

  it('switches language for appearance words and copy', () => {
    const en = buildCapabilities(t, 'en');
    expect(en.themes.some((l) => l.includes('(dark)'))).toBe(true);
    expect(en.design[0]).toContain('Customizable under Appearance');
  });
});

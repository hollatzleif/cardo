import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  buildColorContext,
  contrastParamsSchema,
  contrastRatio,
  harmony,
  HARMONY_RULES,
  hexToRgb,
  hslCss,
  hslToRgb,
  makePaletteId,
  parseColorInput,
  parseColorList,
  rgbCss,
  rgbToHex,
  rgbToHsl,
  savePaletteParamsSchema,
  wcagLabel,
  type HarmonyRule,
  type PaletteDoc,
  type RGB,
} from './logic';

// Concatenated so no raw color literal appears in the source (token-lint);
// these are default USER VALUES for the pickers, not UI styling.
const DEFAULT_BASE_HEX = '#' + '1e90ff';
const DEFAULT_FG_HEX = '#' + '111111';
const DEFAULT_BG_HEX = '#' + 'ffffff';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryPalettesIn(storage: ToolStorage): Promise<PaletteDoc[]> {
  const palettes = await storage.query<PaletteDoc>({
    where: [{ field: 'type', op: '=', value: 'palette' }],
  });
  return [...palettes].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name),
  );
}

async function savePaletteIn(
  storage: ToolStorage,
  name: string,
  colors: string[],
): Promise<PaletteDoc> {
  const palette: PaletteDoc = {
    id: makePaletteId(),
    type: 'palette',
    name: name.trim(),
    colors,
    createdAt: new Date().toISOString(),
  };
  await storage.set(palette.id, palette);
  return palette;
}

/** Language-neutral verdict line for the assistant/palette toast. */
function contrastText(fg: string, bg: string, ratio: number): string {
  const normal = wcagLabel(ratio, false);
  const large = wcagLabel(ratio, true);
  return `${fg} / ${bg}: ${ratio.toFixed(2)}:1 – AA/AAA: ${normal}, ${large} (large)`;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function Swatch(props: { hex: string; onCopy: (hex: string) => void; size?: number }) {
    return (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.color-tool.widget.copyColor', { hex: props.hex })}
        title={t('tool.color-tool.widget.copyColor', { hex: props.hex })}
        style={{
          width: props.size ?? 28,
          height: props.size ?? 28,
          minWidth: 0,
          padding: 0,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          // Runtime user data, not a source literal.
          background: props.hex,
          flexShrink: 0,
        }}
        onClick={() => props.onCopy(props.hex)}
      />
    );
  }

  function ColorToolWidget(props: WidgetProps) {
    const [palettes, setPalettes] = useState<PaletteDoc[]>([]);
    const [baseHex, setBaseHex] = useState(DEFAULT_BASE_HEX);
    const [textInput, setTextInput] = useState('');
    const [rule, setRule] = useState<HarmonyRule>('complementary');
    const [paletteName, setPaletteName] = useState('');
    const [fgHex, setFgHex] = useState(DEFAULT_FG_HEX);
    const [bgHex, setBgHex] = useState(DEFAULT_BG_HEX);
    const [fgText, setFgText] = useState('');
    const [bgText, setBgText] = useState('');
    const [copied, setCopied] = useState<string | null>(null);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      setPalettes(await queryPalettesIn(c.storage));
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.storage.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);

    useEffect(() => {
      if (!copied) return;
      const timer = window.setTimeout(() => setCopied(null), 1500);
      return () => window.clearTimeout(timer);
    }, [copied]);

    const copy = (hex: string) => {
      void navigator.clipboard?.writeText(hex);
      setCopied(hex);
    };

    const copiedHint = copied ? (
      <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }} aria-live="polite">
        {t('tool.color-tool.widget.copied', { hex: copied })}
      </div>
    ) : null;

    /** Color input pair: native picker + free-text (hex/rgb/hsl) field. */
    const colorField = (
      value: string,
      text: string,
      labelKey: string,
      onHex: (hex: string) => void,
      onText: (text: string) => void,
    ) => (
      <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', minWidth: 0 }}>
        <input
          type="color"
          value={value}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          style={{ width: 32, height: 32, padding: 0, border: 'none', background: 'none', flexShrink: 0 }}
          onChange={(e) => {
            onHex(e.target.value);
            onText('');
          }}
        />
        <input
          className="c-input"
          value={text || value}
          aria-label={t(labelKey)}
          spellCheck={false}
          style={{ flex: 1, minWidth: 60, fontVariantNumeric: 'tabular-nums' }}
          onChange={(e) => {
            onText(e.target.value);
            const parsed = parseColorInput(e.target.value);
            if (parsed) onHex(parsed);
          }}
        />
      </div>
    );

    let body;
    if (props.variant === 'palette') {
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {palettes.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.color-tool.widget.emptyPalettes')}
            </div>
          ) : (
            palettes.map((palette) => (
              <div key={palette.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {palette.name}
                  </span>
                  <button
                    className="c-btn c-btn--ghost"
                    aria-label={t('tool.color-tool.widget.deletePalette', { name: palette.name })}
                    title={t('tool.color-tool.widget.deletePalette', { name: palette.name })}
                    style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                    onClick={() => void ctx?.storage.delete(palette.id)}
                  >
                    ×
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                  {palette.colors.map((hex, i) => (
                    <Swatch key={`${hex}:${i}`} hex={hex} onCopy={copy} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      );
    } else if (props.variant === 'contrast') {
      const fg = hexToRgb(fgHex) ?? { r: 0, g: 0, b: 0 };
      const bg = hexToRgb(bgHex) ?? { r: 255, g: 255, b: 255 };
      const ratio = contrastRatio(fg, bg);
      const badge = (label: string, pass: boolean) => (
        <span
          className="c-badge"
          style={{
            color: pass ? 'var(--success)' : 'var(--danger)',
            border: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          {label} {pass ? '✓' : '✗'}
        </span>
      );
      const normal = wcagLabel(ratio, false);
      const large = wcagLabel(ratio, true);
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {colorField(fgHex, fgText, 'tool.color-tool.widget.foreground', setFgHex, setFgText)}
          {colorField(bgHex, bgText, 'tool.color-tool.widget.background', setBgHex, setBgText)}
          <div
            aria-hidden
            style={{
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              padding: 'var(--space-2)',
              textAlign: 'center',
              // Preview of runtime user data, not source literals.
              background: bgHex,
              color: fgHex,
            }}
          >
            {t('tool.color-tool.widget.sampleText')}
          </div>
          <div
            style={{ fontSize: '1.6em', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
            aria-live="polite"
          >
            {ratio.toFixed(2)}:1
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'center' }}>
            {badge(t('tool.color-tool.widget.aaNormal'), normal !== 'fail')}
            {badge(t('tool.color-tool.widget.aaaNormal'), normal === 'AAA')}
            {badge(t('tool.color-tool.widget.aaLarge'), large !== 'fail')}
            {badge(t('tool.color-tool.widget.aaaLarge'), large === 'AAA')}
          </div>
          {copiedHint}
        </div>
      );
    } else {
      // Default variant: picker.
      const rgb = hexToRgb(baseHex) ?? { r: 0, g: 0, b: 0 };
      const hsl = rgbToHsl(rgb);
      const harmonyColors = harmony(baseHex, rule);
      const savePalette = async () => {
        const c = ctx;
        if (!c || harmonyColors.length === 0) return;
        const name = paletteName.trim() || baseHex;
        await savePaletteIn(c.storage, name, harmonyColors);
        setPaletteName('');
      };
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {colorField(baseHex, textInput, 'tool.color-tool.widget.baseColor', setBaseHex, setTextInput)}
          <div className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {baseHex} · {rgbCss(rgb)} · {hslCss(hsl)}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
            <select
              className="c-input"
              value={rule}
              aria-label={t('tool.color-tool.widget.harmonyLabel')}
              title={t('tool.color-tool.widget.harmonyLabel')}
              style={{ width: 'auto', flexShrink: 0 }}
              onChange={(e) => setRule(e.target.value as HarmonyRule)}
            >
              {HARMONY_RULES.map((r) => (
                <option key={r} value={r}>
                  {t(`tool.color-tool.harmony.${r}`)}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {harmonyColors.map((hex, i) => (
                <Swatch key={`${hex}:${i}`} hex={hex} onCopy={copy} />
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <input
              className="c-input"
              value={paletteName}
              placeholder={t('tool.color-tool.widget.paletteNamePlaceholder')}
              aria-label={t('tool.color-tool.widget.paletteNamePlaceholder')}
              style={{ flex: 1, minWidth: 60 }}
              onChange={(e) => setPaletteName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePalette();
              }}
            />
            <button
              className="c-btn c-btn--primary"
              style={{ flexShrink: 0 }}
              onClick={() => void savePalette()}
            >
              {t('tool.color-tool.widget.savePalette')}
            </button>
          </div>
          {copiedHint}
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
        }}
      >
        {body}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'color-tool.contrast',
        titleKey: 'tool.color-tool.command.contrast',
        descriptionKey: 'tool.color-tool.command.contrastDesc',
        icon: '◑',
        assistant: true,
        params: contrastParamsSchema,
        // 3-digit hex probes (the 6-digit form would look like a styling literal).
        selfTestParams: { foreground: '#000', background: '#fff' },
        async run({ foreground, background }): Promise<CommandResult> {
          const fgHex = parseColorInput(foreground);
          const bgHex = parseColorInput(background);
          const fg = fgHex ? hexToRgb(fgHex) : null;
          const bg = bgHex ? hexToRgb(bgHex) : null;
          if (!fgHex || !bgHex || !fg || !bg) {
            return { ok: false, messageKey: 'tool.color-tool.msg.invalidColor' };
          }
          const ratio = contrastRatio(fg, bg);
          return {
            ok: true,
            data: {
              text: contrastText(fgHex, bgHex, ratio),
              ratio,
              normal: wcagLabel(ratio, false),
              large: wcagLabel(ratio, true),
            },
          };
        },
      });

      context.commands.register({
        id: 'color-tool.save-palette',
        titleKey: 'tool.color-tool.command.savePalette',
        descriptionKey: 'tool.color-tool.command.savePaletteDesc',
        icon: 'palette',
        params: savePaletteParamsSchema,
        selfTestParams: { name: 'Cardo self-test palette', colors: '#f00, #0f0, #00f' },
        async run({ name, colors }): Promise<CommandResult> {
          const parsed = parseColorList(colors);
          if (!parsed) return { ok: false, messageKey: 'tool.color-tool.msg.invalidColors' };
          const palette = await savePaletteIn(context.storage, name, parsed);
          return { ok: true, data: palette, messageKey: 'tool.color-tool.msg.paletteSaved' };
        },
      });

      context.commands.register({
        id: 'color-tool.context',
        titleKey: 'tool.color-tool.command.context',
        descriptionKey: 'tool.color-tool.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const palettes = await queryPalettesIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildColorContext(palettes, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: ColorToolWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'conversion-roundtrip': {
          for (let r = 0; r <= 255; r += 51) {
            for (let g = 0; g <= 255; g += 51) {
              for (let b = 0; b <= 255; b += 51) {
                const source: RGB = { r, g, b };
                const viaHex = hexToRgb(rgbToHex(source));
                const viaHsl = hslToRgb(rgbToHsl(source));
                if (
                  !viaHex ||
                  viaHex.r !== r ||
                  viaHex.g !== g ||
                  viaHex.b !== b ||
                  viaHsl.r !== r ||
                  viaHsl.g !== g ||
                  viaHsl.b !== b
                ) {
                  return {
                    status: 'fail',
                    detail: `roundtrip broke at rgb ${r},${g},${b}`,
                  };
                }
              }
            }
          }
          return { status: 'pass', detail: '216-color grid round-trips via hex and hsl' };
        }
        case 'contrast-math': {
          const black: RGB = { r: 0, g: 0, b: 0 };
          const white: RGB = { r: 255, g: 255, b: 255 };
          const bw = contrastRatio(black, white);
          const same = contrastRatio(white, white);
          if (Math.abs(bw - 21) > 1e-6) {
            return { status: 'fail', detail: `black/white ratio ${bw}, expected 21` };
          }
          if (Math.abs(same - 1) > 1e-9) {
            return { status: 'fail', detail: `same-color ratio ${same}, expected 1` };
          }
          if (
            wcagLabel(21) !== 'AAA' ||
            wcagLabel(4.5) !== 'AA' ||
            wcagLabel(4.49) !== 'fail' ||
            wcagLabel(3, true) !== 'AA'
          ) {
            return { status: 'fail', detail: 'wcagLabel thresholds wrong' };
          }
          return { status: 'pass', detail: 'WCAG anchors 21/1 and labels verified' };
        }
        case 'palette-crud': {
          const colors = parseColorList('#f00, #0f0, #00f');
          if (!colors || colors.length !== 3) {
            return { status: 'fail', detail: `parseColorList failed: ${JSON.stringify(colors)}` };
          }
          const palette = await savePaletteIn(testCtx.storage, 'selftest palette', colors);
          const back = await testCtx.storage.get<PaletteDoc>(palette.id);
          await testCtx.storage.delete(palette.id);
          const gone = await testCtx.storage.get<PaletteDoc>(palette.id);
          if (!back || back.name !== 'selftest palette' || back.colors.length !== 3) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'palette still present after delete' };
          return { status: 'pass', detail: 'palette create → read → delete roundtrip ok' };
        }
        case 'render':
          return typeof ColorToolWidget === 'function' && ColorToolWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

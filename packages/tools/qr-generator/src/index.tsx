import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { qrMatrix } from '@cardo/ui';
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
  buildQrContext,
  payloadFor,
  pushRecent,
  QR_MODES,
  wifiPayload,
  WIFI_SECURITIES,
  type QrMode,
  type RecentDoc,
  type WifiSecurity,
} from './logic';

/**
 * QR generator – text/link/Wi-Fi to QR, fully offline via the shared
 * dependency-free encoder in @cardo/ui. Only the size preference and an
 * optional "recent payloads" doc are stored; PNG export goes through a
 * data-URL download (no file permissions needed).
 */

const RECENT_DOC_ID = 'recent';
const CURRENT_DOC_ID = 'current';
const QUIET_ZONE = 4;
const MIN_SIZE = 128;
const MAX_SIZE = 512;

type CurrentDoc = { id: string; type: 'current'; payload: string };

type QrSettings = { size: number; saveRecent: boolean };
const DEFAULT_SETTINGS: QrSettings = { size: 256, saveRecent: true };

const canvasSupported = (): boolean => typeof CanvasRenderingContext2D !== 'undefined';

/** Paint a QR matrix onto a canvas with an n-module quiet zone. */
function paintMatrix(
  canvas: HTMLCanvasElement,
  matrix: readonly (readonly boolean[])[],
  targetPx: number,
  darkColor: string,
  lightColor: string,
): void {
  if (!canvasSupported()) return;
  const g = canvas.getContext('2d');
  if (!g) return;
  const modules = matrix.length + QUIET_ZONE * 2;
  const scale = Math.max(1, Math.floor(targetPx / modules));
  canvas.width = modules * scale;
  canvas.height = modules * scale;
  g.fillStyle = lightColor;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = darkColor;
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) g.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
    }
  }
}

/** Theme colors for the on-screen canvas, resolved from the design tokens. */
function themeColors(): { dark: string; light: string } {
  const styles = getComputedStyle(document.documentElement);
  // Canvas needs real pixel colors; CSS keywords only as last-resort fallbacks.
  return {
    dark: styles.getPropertyValue('--text-primary').trim() || 'black',
    light: styles.getPropertyValue('--bg-widget').trim() || 'white',
  };
}

async function loadRecent(storage: ToolStorage): Promise<string[]> {
  const doc = await storage.get<RecentDoc>(RECENT_DOC_ID);
  return doc?.entries ?? [];
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<QrSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [size, saveRecent] = await Promise.all([
      c.settings.get<number>('size'),
      c.settings.get<boolean>('saveRecent'),
    ]);
    return {
      size: typeof size === 'number' ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, size)) : DEFAULT_SETTINGS.size,
      saveRecent: typeof saveRecent === 'boolean' ? saveRecent : DEFAULT_SETTINGS.saveRecent,
    };
  }

  async function rememberPayload(storage: ToolStorage, payload: string): Promise<void> {
    const settings = await loadSettings();
    if (!settings.saveRecent || !payload) return;
    const entries = await loadRecent(storage);
    await storage.set<RecentDoc>(RECENT_DOC_ID, {
      id: RECENT_DOC_ID,
      type: 'recent',
      entries: pushRecent(entries, payload),
    });
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function QrCanvas(props: { payload: string; sizePx: number; caption?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const matrix = useMemo(() => (props.payload ? qrMatrix(props.payload) : null), [props.payload]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !matrix) return;
      const { dark, light } = themeColors();
      paintMatrix(canvas, matrix, props.sizePx, dark, light);
    }, [matrix, props.sizePx]);

    if (!props.payload) {
      return <span className="c-muted">{t('tool.qr-generator.widget.empty')}</span>;
    }
    if (!matrix) {
      return <span style={{ color: 'var(--danger)' }}>{t('tool.qr-generator.widget.tooLong')}</span>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-1)', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('tool.qr-generator.widget.qrLabel')}
          style={{ maxWidth: '100%', maxHeight: '100%', imageRendering: 'pixelated' }}
        />
        {props.caption && (
          <div
            className="c-muted"
            style={{
              fontSize: '0.75em',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              wordBreak: 'break-all',
              textAlign: 'center',
              maxWidth: '100%',
            }}
          >
            {props.payload}
          </div>
        )}
      </div>
    );
  }

  function savePng(payload: string): void {
    const matrix = payload ? qrMatrix(payload) : null;
    if (!matrix || !canvasSupported()) return;
    const off = document.createElement('canvas');
    // Exported PNGs use pure black/white keywords for maximum scan contrast.
    paintMatrix(off, matrix, (matrix.length + QUIET_ZONE * 2) * 8, 'black', 'white');
    const link = document.createElement('a');
    link.href = off.toDataURL('image/png');
    link.download = 'qr-code.png';
    link.click();
  }

  function SettingRow(props: { labelKey: string; children: ReactNode }) {
    return (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span className="c-muted" style={{ fontSize: '0.85em' }}>
          {t(props.labelKey)}
        </span>
        {props.children}
      </label>
    );
  }

  function QrWidget(props: WidgetProps) {
    const variant = props.variant ?? 'code';
    const [mode, setMode] = useState<QrMode>('text');
    const [text, setText] = useState('');
    const [url, setUrl] = useState('');
    const [ssid, setSsid] = useState('');
    const [password, setPassword] = useState('');
    const [security, setSecurity] = useState<WifiSecurity>('WPA');
    const [batch, setBatch] = useState('');
    const [settings, setSettings] = useState<QrSettings>({ ...DEFAULT_SETTINGS });
    const [showSettings, setShowSettings] = useState(false);

    // Load prefs + the payload the qr-generator.make command stored last.
    useEffect(() => {
      let mounted = true;
      const load = () => {
        void loadSettings().then((next) => {
          if (mounted) setSettings(next);
        });
      };
      load();
      const applyCurrent = () => {
        void ctx?.storage.get<CurrentDoc>(CURRENT_DOC_ID).then((doc) => {
          if (mounted && doc?.payload) {
            setMode('text');
            setText(doc.payload);
          }
        });
      };
      applyCurrent();
      const unsubSettings = ctx?.settings.subscribe(load);
      const unsubStorage = ctx?.storage.subscribe((change) => {
        if (change.docId === CURRENT_DOC_ID) applyCurrent();
      });
      return () => {
        mounted = false;
        unsubSettings?.();
        unsubStorage?.();
      };
    }, []);

    const payload =
      payloadFor(mode, { text, url, ssid, password, security }) ?? '';
    const encodable = useMemo(() => (payload ? qrMatrix(payload) !== null : false), [payload]);

    async function updateSetting<K extends keyof QrSettings>(key: K, value: QrSettings[K]) {
      setSettings((prev) => ({ ...prev, [key]: value }));
      await ctx?.settings.set(key, value);
    }

    function remember(): void {
      if (ctx && payload) void rememberPayload(ctx.storage, payload);
    }

    const modeTabs = (
      <div role="tablist" style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        {QR_MODES.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className="c-btn c-btn--ghost"
            style={{
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '0.85em',
              ...(mode === m
                ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
                : { color: 'var(--text-muted)' }),
            }}
            onClick={() => setMode(m)}
          >
            {t(`tool.qr-generator.widget.mode.${m}`)}
          </button>
        ))}
      </div>
    );

    const inputs =
      mode === 'wifi' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0 }}>
          <input
            className="c-input"
            value={ssid}
            placeholder={t('tool.qr-generator.widget.ssidPlaceholder')}
            aria-label={t('tool.qr-generator.widget.ssidPlaceholder')}
            onChange={(e) => setSsid(e.target.value)}
            onBlur={remember}
          />
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <input
              className="c-input"
              type="password"
              style={{ flex: 1, minWidth: 0 }}
              value={password}
              disabled={security === 'nopass'}
              placeholder={t('tool.qr-generator.widget.passwordPlaceholder')}
              aria-label={t('tool.qr-generator.widget.passwordPlaceholder')}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={remember}
            />
            <select
              className="c-input"
              style={{ width: 'auto', flexShrink: 0 }}
              value={security}
              aria-label={t('tool.qr-generator.widget.securityLabel')}
              title={t('tool.qr-generator.widget.securityLabel')}
              onChange={(e) => setSecurity(e.target.value as WifiSecurity)}
            >
              {WIFI_SECURITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`tool.qr-generator.widget.security.${s}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <input
          className="c-input"
          style={{ flexShrink: 0 }}
          value={mode === 'url' ? url : text}
          placeholder={t(`tool.qr-generator.widget.placeholder.${mode}`)}
          aria-label={t(`tool.qr-generator.widget.placeholder.${mode}`)}
          onChange={(e) => (mode === 'url' ? setUrl(e.target.value) : setText(e.target.value))}
          onBlur={remember}
        />
      );

    const settingsPanel = showSettings && (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          width: '100%',
          maxWidth: '260px',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
          flexShrink: 0,
        }}
      >
        <SettingRow labelKey="tool.qr-generator.settings.size">
          <input
            className="c-input"
            type="range"
            min={MIN_SIZE}
            max={MAX_SIZE}
            step={32}
            value={settings.size}
            style={{ width: '120px', padding: 0 }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) void updateSetting('size', v);
            }}
          />
        </SettingRow>
        <SettingRow labelKey="tool.qr-generator.settings.saveRecent">
          <input
            type="checkbox"
            checked={settings.saveRecent}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void updateSetting('saveRecent', e.target.checked)}
          />
        </SettingRow>
        <div className="c-muted" style={{ fontSize: '0.75em' }}>
          {t('tool.qr-generator.settings.ecInfo')}
        </div>
      </div>
    );

    const actions = (
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
        <button
          className="c-btn c-btn--ghost"
          disabled={!encodable}
          aria-label={t('tool.qr-generator.widget.savePng')}
          title={t('tool.qr-generator.widget.savePng')}
          onClick={() => {
            remember();
            savePng(payload);
          }}
        >
          ⬇ {t('tool.qr-generator.widget.savePng')}
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.qr-generator.widget.settingsToggle')}
          title={t('tool.qr-generator.widget.settingsToggle')}
          aria-expanded={showSettings}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    if (variant === 'batch') {
      const payloads = batch
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
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
          <textarea
            className="c-input"
            style={{ height: '5em', resize: 'none', flexShrink: 0, fontFamily: 'inherit' }}
            value={batch}
            placeholder={t('tool.qr-generator.widget.batchPlaceholder')}
            aria-label={t('tool.qr-generator.widget.batchPlaceholder')}
            onChange={(e) => setBatch(e.target.value)}
          />
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
              gap: 'var(--space-2)',
              alignContent: 'start',
            }}
          >
            {payloads.length === 0 ? (
              <span className="c-muted">{t('tool.qr-generator.widget.batchEmpty')}</span>
            ) : (
              payloads.map((line, i) => (
                <div key={`${i}-${line}`} style={{ minWidth: 0 }}>
                  <QrCanvas payload={line} sizePx={110} caption />
                </div>
              ))
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          overflow: 'auto',
        }}
      >
        {modeTabs}
        {inputs}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <QrCanvas payload={payload} sizePx={settings.size} caption={variant === 'with-caption'} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
          {actions}
          {settingsPanel}
        </div>
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'qr-generator.make',
        titleKey: 'tool.qr-generator.command.make',
        descriptionKey: 'tool.qr-generator.command.makeDesc',
        icon: '▦',
        params: z.object({ text: z.string().min(1).max(1000) }),
        selfTestParams: { text: 'CARDO' },
        async run({ text }): Promise<CommandResult> {
          const matrix = qrMatrix(text);
          if (!matrix) return { ok: false, messageKey: 'tool.qr-generator.msg.tooLong' };
          await context.storage.set<CurrentDoc>(CURRENT_DOC_ID, {
            id: CURRENT_DOC_ID,
            type: 'current',
            payload: text,
          });
          await rememberPayload(context.storage, text);
          return {
            ok: true,
            data: { payload: text, modules: matrix.length },
            messageKey: 'tool.qr-generator.msg.made',
          };
        },
      });

      context.commands.register({
        id: 'qr-generator.context',
        titleKey: 'tool.qr-generator.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const entries = await loadRecent(context.storage);
          return { ok: true, data: { contextText: buildQrContext(entries, context.i18n.language) } };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: QrWidget,
    async runSelfTest(testId: string, _testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'matrix': {
          const m = qrMatrix('CARDO');
          if (!m) return { status: 'fail', detail: 'qrMatrix("CARDO") returned null' };
          if (m.length !== 21 || m.some((row) => row.length !== 21)) {
            return { status: 'fail', detail: `expected a 21×21 matrix, got ${m.length}` };
          }
          if (m[13]?.[8] !== true) {
            return { status: 'fail', detail: 'dark module at (13, 8) missing' };
          }
          for (let i = 8; i <= 12; i++) {
            if (m[6]?.[i] !== (i % 2 === 0)) {
              return { status: 'fail', detail: `timing pattern broken at column ${i}` };
            }
          }
          return { status: 'pass', detail: 'structure of the version-1 symbol is intact' };
        }
        case 'wifi-escaping': {
          const escaped = wifiPayload('a;b', 'p:w,x"y\\z', 'WPA');
          if (escaped !== 'WIFI:T:WPA;S:a\\;b;P:p\\:w\\,x\\"y\\\\z;;') {
            return { status: 'fail', detail: `bad escaping: ${escaped}` };
          }
          if (wifiPayload('', 'pw', 'WPA') !== null) {
            return { status: 'fail', detail: 'empty SSID must be rejected' };
          }
          if (wifiPayload('open', 'ignored', 'nopass') !== 'WIFI:T:nopass;S:open;;') {
            return { status: 'fail', detail: 'nopass must omit the password field' };
          }
          return { status: 'pass', detail: 'Wi-Fi specials escaped per spec' };
        }
        case 'render':
          return typeof QrWidget === 'function' && QrWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

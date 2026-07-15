import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  DEFAULT_OPTIONS,
  MAX_LENGTH,
  MAX_WORDS,
  MIN_LENGTH,
  MIN_WORDS,
  clampLength,
  defaultRandomInts,
  entropyBits,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  strengthLabel,
  type PasswordOptions,
  type StrengthLabel,
} from './logic';

/**
 * Password generator – strong passwords and passphrases, fully local.
 * PRIVACY BY DESIGN: generated values are NEVER persisted anywhere; only
 * generator preferences (length, charset toggles, word count) live in
 * ctx.settings. Randomness comes from crypto.getRandomValues with
 * rejection sampling (no modulo bias).
 */

type GenSettings = PasswordOptions & { words: number; separator: string };

const DEFAULT_SETTINGS: GenSettings = { ...DEFAULT_OPTIONS, words: 5, separator: '-' };

const STRENGTH_TOKEN: Record<StrengthLabel, string> = {
  weak: 'var(--danger)',
  ok: 'var(--warning)',
  strong: 'var(--success)',
  excellent: 'var(--success)',
};

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Settings (preferences only – never generated values) ──────────── */

  async function loadSettings(): Promise<GenSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof GenSettings>;
    const values = await Promise.all(keys.map((key) => c.settings.get<GenSettings[typeof key]>(key)));
    const settings = { ...DEFAULT_SETTINGS };
    keys.forEach((key, i) => {
      const value = values[i];
      if (value !== null && value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
        (settings as Record<string, unknown>)[key] = value;
      }
    });
    settings.length = clampLength(settings.length);
    return settings;
  }

  async function generateFromSettings(lengthOverride?: number): Promise<CommandResult> {
    const settings = await loadSettings();
    const opts: PasswordOptions = {
      ...settings,
      length: clampLength(lengthOverride ?? settings.length),
    };
    const password = generatePassword(opts, defaultRandomInts);
    if (password === null) return { ok: false, messageKey: 'tool.password-gen.msg.noClasses' };
    const bits = entropyBits(opts);
    return {
      ok: true,
      messageKey: 'tool.password-gen.msg.generated',
      data: { password, entropyBits: Math.round(bits), strength: strengthLabel(bits) },
    };
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

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

  function PasswordWidget(props: WidgetProps) {
    const variant = props.variant ?? 'generator';
    const passphrase = variant === 'passphrase';
    const compact = variant === 'compact';

    const [settings, setSettings] = useState<GenSettings>({ ...DEFAULT_SETTINGS });
    const [value, setValue] = useState('');
    const [copied, setCopied] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    const regenerate = useCallback((s: GenSettings) => {
      if (passphrase) {
        setValue(generatePassphrase(s.words, s.separator || '-', defaultRandomInts));
      } else {
        setValue(generatePassword(s, defaultRandomInts) ?? '');
      }
      setCopied(false);
    }, [passphrase]);

    // Load prefs once, then regenerate whenever they change elsewhere.
    useEffect(() => {
      let mounted = true;
      const load = () => {
        void loadSettings().then((next) => {
          if (!mounted) return;
          setSettings(next);
          regenerate(next);
        });
      };
      load();
      const unsub = ctx?.settings.subscribe(load);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [regenerate]);

    async function updateSetting<K extends keyof GenSettings>(key: K, val: GenSettings[K]) {
      const next = { ...settings, [key]: val };
      setSettings(next);
      regenerate(next);
      await ctx?.settings.set(key, val);
    }

    async function copy() {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        /* clipboard unavailable (permissions) – the value stays selectable */
      }
    }

    const bits = passphrase ? passphraseEntropyBits(settings.words) : entropyBits(settings);
    const label = strengthLabel(bits);
    const noClasses = !passphrase && value === '';

    const valueBox = (
      <div
        aria-label={t('tool.password-gen.widget.valueLabel')}
        title={t('tool.password-gen.widget.valueLabel')}
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: compact ? '1em' : '1.15em',
          lineHeight: 1.4,
          userSelect: 'all',
          wordBreak: 'break-all',
          textAlign: 'center',
          padding: 'var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border-subtle)',
          width: '100%',
        }}
      >
        {noClasses ? <span className="c-muted">{t('tool.password-gen.widget.noClasses')}</span> : value}
      </div>
    );

    const buttons = (
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.password-gen.widget.regenerate')}
          title={t('tool.password-gen.widget.regenerate')}
          onClick={() => regenerate(settings)}
        >
          ↻ {compact ? '' : t('tool.password-gen.widget.regenerate')}
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.password-gen.widget.copy')}
          title={t('tool.password-gen.widget.copy')}
          disabled={!value}
          onClick={() => void copy()}
        >
          {copied ? t('tool.password-gen.widget.copied') : t('tool.password-gen.widget.copy')}
        </button>
        {!compact && (
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.password-gen.widget.settingsToggle')}
            title={t('tool.password-gen.widget.settingsToggle')}
            aria-expanded={showSettings}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        )}
      </div>
    );

    const strengthMeter = !compact && (
      <div style={{ width: '100%', flexShrink: 0 }}>
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={128}
          aria-valuenow={Math.round(Math.min(bits, 128))}
          aria-label={t('tool.password-gen.widget.strengthLabel')}
          style={{
            width: '100%',
            height: '6px',
            borderRadius: '999px',
            background: 'var(--border-subtle)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.min(100, (bits / 128) * 100)}%`,
              height: '100%',
              borderRadius: '999px',
              background: STRENGTH_TOKEN[label],
              transition: 'width 0.2s ease',
            }}
          />
        </div>
        <div className="c-muted" style={{ fontSize: '0.75em', marginTop: 'var(--space-1)', textAlign: 'center' }}>
          {t(`tool.password-gen.widget.strength.${label}`)} · {t('tool.password-gen.widget.bits', { bits: Math.round(bits) })}
        </div>
      </div>
    );

    const checkbox = (key: 'lower' | 'upper' | 'digits' | 'symbols' | 'excludeAmbiguous') => (
      <SettingRow labelKey={`tool.password-gen.settings.${key}`}>
        <input
          type="checkbox"
          checked={settings[key]}
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => void updateSetting(key, e.target.checked)}
        />
      </SettingRow>
    );

    const settingsPanel = showSettings && !compact && (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          width: '100%',
          maxWidth: '260px',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
        }}
      >
        {passphrase ? (
          <>
            <SettingRow labelKey="tool.password-gen.settings.words">
              <input
                className="c-input"
                type="number"
                min={MIN_WORDS}
                max={MAX_WORDS}
                value={settings.words}
                style={{ width: '72px', textAlign: 'right' }}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value));
                  if (Number.isFinite(v) && v >= MIN_WORDS && v <= MAX_WORDS) void updateSetting('words', v);
                }}
              />
            </SettingRow>
            <SettingRow labelKey="tool.password-gen.settings.separator">
              <input
                className="c-input"
                type="text"
                maxLength={3}
                value={settings.separator}
                style={{ width: '72px', textAlign: 'right' }}
                onChange={(e) => void updateSetting('separator', e.target.value)}
              />
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow labelKey="tool.password-gen.settings.length">
              <input
                className="c-input"
                type="number"
                min={MIN_LENGTH}
                max={MAX_LENGTH}
                value={settings.length}
                style={{ width: '72px', textAlign: 'right' }}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value));
                  if (Number.isFinite(v) && v >= MIN_LENGTH && v <= MAX_LENGTH) void updateSetting('length', v);
                }}
              />
            </SettingRow>
            {checkbox('lower')}
            {checkbox('upper')}
            {checkbox('digits')}
            {checkbox('symbols')}
            {checkbox('excludeAmbiguous')}
          </>
        )}
      </div>
    );

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          overflow: 'auto',
        }}
      >
        {valueBox}
        {strengthMeter}
        {buttons}
        {settingsPanel}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;
      // No `.context` command on purpose: this tool holds no state worth
      // summarizing – and generated passwords must never reach a prompt.
      context.commands.register({
        id: 'password-gen.generate',
        titleKey: 'tool.password-gen.command.generate',
        descriptionKey: 'tool.password-gen.command.generateDesc',
        icon: '🔑',
        params: z.object({ length: z.number().int().min(MIN_LENGTH).max(MAX_LENGTH).optional() }),
        selfTestParams: { length: 16 },
        async run({ length }): Promise<CommandResult> {
          return generateFromSettings(length);
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: PasswordWidget,
    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'no-persist': {
          const result = await testCtx.commands.execute('password-gen.generate', { length: 12 });
          if (!result.ok) return { status: 'fail', detail: 'generate command failed' };
          const data = result.data as { password?: string };
          if (typeof data?.password !== 'string' || data.password.length !== 12) {
            return { status: 'fail', detail: 'generate returned no 12-char password' };
          }
          const docs = await testCtx.storage.query();
          if (docs.length !== 0) {
            return { status: 'fail', detail: `expected empty storage, found ${docs.length} doc(s)` };
          }
          return { status: 'pass', detail: 'generation leaves no trace in storage' };
        }
        case 'determinism': {
          const counter = (): ((count: number, max: number) => number[]) => {
            let n = 0;
            return (count, max) => Array.from({ length: count }, () => (n += 7) % max);
          };
          const opts = { ...DEFAULT_OPTIONS, length: 24 };
          const a = generatePassword(opts, counter());
          const b = generatePassword(opts, counter());
          if (a === null || a !== b) {
            return { status: 'fail', detail: `injected randomness not deterministic: "${a}" vs "${b}"` };
          }
          if (a.length !== 24) return { status: 'fail', detail: `expected 24 chars, got ${a.length}` };
          if (!/[a-z]/.test(a) || !/[A-Z]/.test(a) || !/[0-9]/.test(a)) {
            return { status: 'fail', detail: 'class guarantee violated' };
          }
          return { status: 'pass', detail: 'same seed → same password, classes guaranteed' };
        }
        case 'render':
          return typeof PasswordWidget === 'function' && PasswordWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

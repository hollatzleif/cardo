import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  MAX_WEIGHT,
  MIN_WEIGHT,
  PICKER_MODES,
  STATE_DOC_ID,
  buildPickerContext,
  clampWeight,
  coinFlip,
  defaultRandomInts,
  mergeOptions,
  migrateLegacyItems,
  parseItems,
  randomInRange,
  rollDice,
  secureRandomInt,
  shuffleAll,
  weightedPickIndex,
  weightedPickN,
  yesNo,
  type CoinSide,
  type DiceRoll,
  type LegacyListDoc,
  type PickerMode,
  type PickerOption,
  type PickerStateDoc,
} from './logic';

/**
 * Random picker – wheel, dice, coin, number range, yes/no, shuffle and
 * pick-N, fully local. Options are entered right in the widget and live in
 * ONE ephemeral `state` doc (they survive reloads, but there is no list
 * management). Picking is weighted (rejection-sampled crypto randomness).
 */

const SPIN_MS = 2000;
const WHEEL_TURNS = 4;
/** Gentle settle wobble at the very end of the wheel spin. */
const WOBBLE_MS = 200;
const WOBBLE_RAD = 0.035; // ≈2° overshoot amplitude
/** Coin flip: even number of half-turns → the coin lands front-facing. */
const COIN_MS = 1000;
const COIN_HALF_TURNS = 6;
/** Dice shuffle: rapid face changes with decreasing speed. */
const DICE_MS = 600;

/** Modes that operate on the entered options (the rest are parameter-only). */
const OPTION_MODES: readonly PickerMode[] = ['wheel', 'shuffle', 'pick-n'];

/** All animations collapse to instant results when the user prefers reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const DICE_GLYPHS: readonly string[] = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

/** Dice faces as glyphs (d6) or plain numbers (any other die). */
function diceFacesText(rolls: readonly number[], sides: number): string {
  if (sides === 6) return rolls.map((v) => DICE_GLYPHS[v - 1] ?? String(v)).join(' ');
  return rolls.join('  ');
}

function isPickerMode(value: unknown): value is PickerMode {
  return typeof value === 'string' && (PICKER_MODES as readonly string[]).includes(value);
}

function emptyState(): PickerStateDoc {
  return { id: STATE_DOC_ID, type: 'state', options: [], mode: 'wheel' };
}

/** Read + sanitize the singleton state doc (junk weights/modes are healed). */
async function loadState(storage: ToolStorage): Promise<PickerStateDoc> {
  const doc = await storage.get<Partial<PickerStateDoc>>(STATE_DOC_ID);
  if (!doc) return emptyState();
  const options: PickerOption[] = Array.isArray(doc.options)
    ? doc.options
        .filter(
          (o): o is PickerOption =>
            typeof o === 'object' && o !== null && typeof (o as { text?: unknown }).text === 'string',
        )
        .map((o) => ({ text: o.text, weight: clampWeight(o.weight) }))
        .filter((o) => o.text.trim().length > 0)
    : [];
  const state: PickerStateDoc = {
    id: STATE_DOC_ID,
    type: 'state',
    options,
    mode: isPickerMode(doc.mode) ? doc.mode : 'wheel',
  };
  if (typeof doc.lastResult === 'string' && doc.lastResult.length > 0) {
    state.lastResult = doc.lastResult;
  }
  return state;
}

/**
 * One-shot migration from the pre-1.1 saved-lists era: the FIRST legacy
 * list's items become the working options (weight 1, unless a state doc
 * already exists), then ALL legacy docs are deleted – they are invisible now.
 */
async function migrateLegacy(storage: ToolStorage): Promise<void> {
  const legacy = await storage.query<LegacyListDoc>({
    where: [{ field: 'type', op: '=', value: 'list' }],
    orderBy: 'createdAt',
    direction: 'asc',
  });
  if (legacy.length === 0) return;
  const existing = await storage.get<PickerStateDoc>(STATE_DOC_ID);
  if (!existing) {
    await storage.set<PickerStateDoc>(STATE_DOC_ID, {
      id: STATE_DOC_ID,
      type: 'state',
      options: migrateLegacyItems(legacy),
      mode: 'wheel',
    });
  }
  for (const doc of legacy) {
    await storage.delete(doc.id);
  }
}

/** Weighted pick from stored (or inline) options; null when nothing to pick. */
function pickWeighted(options: readonly PickerOption[]): { pick: string; index: number } | null {
  const index = weightedPickIndex(
    options.map((o) => o.weight),
    secureRandomInt,
  );
  if (index === null) return null;
  return { pick: options[index]?.text ?? '', index };
}

/** Draw the wheel with segment arcs ∝ weight; no-op without a 2D context (tests). */
function drawWheel(canvas: HTMLCanvasElement, options: readonly PickerOption[], rotation: number): void {
  if (typeof CanvasRenderingContext2D === 'undefined') return;
  const g = canvas.getContext('2d');
  if (!g) return;
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 10;
  const styles = getComputedStyle(document.documentElement);
  // Real pixel colors are required on a canvas: resolve the design tokens at
  // draw time; CSS color KEYWORDS only as last-resort fallbacks.
  const color = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback;
  g.clearRect(0, 0, size, size);
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  if (options.length === 0 || total <= 0) return;
  let cumulative = 0;
  for (let i = 0; i < options.length; i++) {
    const weight = options[i]?.weight ?? 0;
    const start = rotation + (cumulative / total) * Math.PI * 2;
    cumulative += weight;
    const end = rotation + (cumulative / total) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, radius, start, end);
    g.closePath();
    g.fillStyle = color(`--chart-${(i % 8) + 1}`, 'gray');
    g.fill();
    g.strokeStyle = color('--bg-widget', 'white');
    g.lineWidth = 2;
    g.stroke();
    if (options.length <= 24) {
      g.save();
      g.translate(cx, cy);
      g.rotate((start + end) / 2);
      g.textAlign = 'right';
      g.fillStyle = color('--accent-text', 'white');
      g.font = `${Math.max(10, Math.round(size / 22))}px sans-serif`;
      g.fillText((options[i]?.text ?? '').slice(0, 14), radius - 8, 4);
      g.restore();
    }
  }
  // Pointer/tick indicator at 12 o'clock: small accent triangle, outlined in
  // the widget background so it reads on every segment color.
  g.beginPath();
  g.moveTo(cx - 9, 1);
  g.lineTo(cx + 9, 1);
  g.lineTo(cx, 20);
  g.closePath();
  g.fillStyle = color('--accent', 'black');
  g.fill();
  g.strokeStyle = color('--bg-widget', 'white');
  g.lineWidth = 2;
  g.stroke();
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function PickerWidget(props: WidgetProps) {
    const variant = props.variant ?? 'full';
    const [state, setState] = useState<PickerStateDoc>(emptyState);
    const [spinning, setSpinning] = useState(false);
    const [optionsDraft, setOptionsDraft] = useState<string | null>(null);
    const [diceSpec, setDiceSpec] = useState('2d6');
    const [minDraft, setMinDraft] = useState('1');
    const [maxDraft, setMaxDraft] = useState('100');
    const [withMaybe, setWithMaybe] = useState(false);
    const [countDraft, setCountDraft] = useState('2');
    const [invalid, setInvalid] = useState<'dice' | 'range' | null>(null);
    const [coinFace, setCoinFace] = useState<CoinSide | null>(null);
    const [diceFaces, setDiceFaces] = useState<string | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rotationRef = useRef(0);
    const animRef = useRef<number | null>(null);
    const coinRef = useRef<HTMLDivElement | null>(null);
    const coinAnimRef = useRef<Animation | null>(null);
    const diceTimerRef = useRef<number | null>(null);

    /** Stop every running presentation animation (refs only – safe on unmount). */
    const cancelAnimations = useCallback(() => {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      if (coinAnimRef.current !== null) {
        coinAnimRef.current.cancel(); // cancelled animations never fire onfinish
        coinAnimRef.current = null;
      }
      if (diceTimerRef.current !== null) {
        window.clearTimeout(diceTimerRef.current);
        diceTimerRef.current = null;
      }
    }, []);

    const reload = useCallback(async () => {
      if (!ctx) return;
      setState(await loadState(ctx.storage));
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
        cancelAnimations();
      };
    }, [reload, cancelAnimations]);

    const mode = state.mode;
    const options = state.options;
    const weights = options.map((o) => o.weight);
    const texts = options.map((o) => o.text);
    const usesOptions = OPTION_MODES.includes(mode);

    useEffect(() => {
      if (state.mode !== 'wheel') return;
      const canvas = canvasRef.current;
      if (canvas) drawWheel(canvas, state.options, rotationRef.current);
    }, [variant, state]);

    /** Merge a patch into the STORED state (read-fresh, no stale closure). */
    const save = useCallback(async (patch: Partial<PickerStateDoc>) => {
      if (!ctx) return;
      const current = await loadState(ctx.storage);
      await ctx.storage.set<PickerStateDoc>(STATE_DOC_ID, {
        ...current,
        ...patch,
        id: STATE_DOC_ID,
        type: 'state',
      });
    }, []);

    function commitResult(text: string): void {
      setState((prev) => ({ ...prev, lastResult: text }));
      void save({ lastResult: text });
    }

    function setMode(next: PickerMode): void {
      cancelAnimations();
      setSpinning(false);
      setCoinFace(null);
      setDiceFaces(null);
      setInvalid(null);
      setState((prev) => ({ ...prev, mode: next }));
      void save({ mode: next });
    }

    function setOptions(next: PickerOption[]): void {
      setState((prev) => ({ ...prev, options: next }));
      void save({ options: next });
    }

    function setWeight(index: number, weight: number): void {
      setOptions(options.map((o, i) => (i === index ? { ...o, weight: clampWeight(weight) } : o)));
    }

    /** Rotation that parks segment `index`'s CENTER under the pointer (top). */
    function targetFor(index: number): number {
      const total = weights.reduce((sum, w) => sum + w, 0);
      let before = 0;
      for (let i = 0; i < index; i++) before += weights[i] ?? 0;
      const center = ((before + (weights[index] ?? 0) / 2) / Math.max(1, total)) * Math.PI * 2;
      let target = -Math.PI / 2 - center;
      while (target < rotationRef.current + WHEEL_TURNS * Math.PI * 2) target += Math.PI * 2;
      return target;
    }

    function spin(): void {
      if (spinning) return;
      const picked = pickWeighted(options);
      if (!picked) return;
      const canvas = canvasRef.current;
      if (!canvas || prefersReducedMotion()) {
        // No canvas in this variant (or reduced motion): instant result.
        if (canvas) {
          rotationRef.current = targetFor(picked.index);
          drawWheel(canvas, options, rotationRef.current);
        }
        commitResult(picked.pick);
        return;
      }
      setSpinning(true);
      const startRotation = rotationRef.current;
      const target = targetFor(picked.index);
      const startTime = performance.now();
      const wobbleFrom = 1 - WOBBLE_MS / SPIN_MS;
      const step = (now: number): void => {
        const progress = Math.min(1, (now - startTime) / SPIN_MS);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        let rotation = startRotation + (target - startRotation) * eased;
        if (progress > wobbleFrom) {
          // Gentle settle wobble over the last WOBBLE_MS: a damped full sine
          // swing that is exactly 0 at progress 1 (lands precisely on target).
          const wp = (progress - wobbleFrom) / (1 - wobbleFrom);
          rotation += WOBBLE_RAD * Math.sin(wp * Math.PI * 2) * (1 - wp);
        }
        rotationRef.current = rotation;
        drawWheel(canvas, options, rotationRef.current);
        if (progress < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          animRef.current = null;
          setSpinning(false);
          commitResult(picked.pick);
        }
      };
      animRef.current = requestAnimationFrame(step);
    }

    /**
     * Coin flip: the RESULT is decided up front (pure logic); the WAAPI
     * animation is presentation only – ~1s of 3D half-turns with ease-out,
     * landing front-facing, then the result face and text appear.
     */
    function animateCoin(side: CoinSide): void {
      const finish = (): void => {
        setCoinFace(side);
        commitResult(t(`tool.random-picker.result.${side}`));
      };
      const el = coinRef.current;
      // No coin element in this variant, no WAAPI (tests) or reduced motion:
      // show the result immediately.
      if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) {
        finish();
        return;
      }
      setSpinning(true);
      setCoinFace(null); // neutral face while airborne
      const degrees = COIN_HALF_TURNS * 180; // even count → ends front-facing
      const anim = el.animate(
        [
          { transform: 'rotateY(0deg) translateY(0px)' },
          { transform: `rotateY(${degrees / 2}deg) translateY(-14px)`, offset: 0.45 },
          { transform: `rotateY(${degrees}deg) translateY(0px)` },
        ],
        { duration: COIN_MS, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }, // ease-out cubic
      );
      coinAnimRef.current = anim;
      anim.onfinish = () => {
        coinAnimRef.current = null;
        setSpinning(false);
        finish();
      };
    }

    /**
     * Dice roll: the rolls are final BEFORE the animation; the faces just
     * shuffle rapidly (decreasing speed, ~600ms) before settling on them.
     */
    function animateDice(rolled: DiceRoll): void {
      const settle = (): void => {
        setDiceFaces(diceFacesText(rolled.rolls, rolled.sides));
        commitResult(`${rolled.total} (${rolled.rolls.join(' + ')})`);
      };
      // Compact has no dice display; reduced motion skips the shuffle.
      if (variant === 'compact' || prefersReducedMotion()) {
        settle();
        return;
      }
      setSpinning(true);
      const startTime = performance.now();
      let delay = 45;
      const tick = (): void => {
        if (performance.now() - startTime >= DICE_MS) {
          diceTimerRef.current = null;
          setSpinning(false);
          settle();
          return;
        }
        // Throwaway faces – presentation only, never the result.
        const faces = defaultRandomInts(rolled.count, rolled.sides).map((v) => v + 1);
        setDiceFaces(diceFacesText(faces, rolled.sides));
        delay *= 1.3; // slow down towards the end
        diceTimerRef.current = window.setTimeout(tick, delay);
      };
      tick();
    }

    function runAction(): void {
      if (spinning) return; // e.g. Enter in the dice input while animating
      setInvalid(null);
      switch (mode) {
        case 'wheel':
          spin();
          return;
        case 'dice': {
          const rolled = rollDice(diceSpec, defaultRandomInts);
          if (!rolled) {
            setInvalid('dice');
            return;
          }
          animateDice(rolled);
          return;
        }
        case 'coin':
          animateCoin(coinFlip(secureRandomInt));
          return;
        case 'number': {
          const value = randomInRange(Number(minDraft), Number(maxDraft), secureRandomInt);
          if (value === null) {
            setInvalid('range');
            return;
          }
          commitResult(String(value));
          return;
        }
        case 'yes-no':
          commitResult(t(`tool.random-picker.result.${yesNo(withMaybe, secureRandomInt)}`));
          return;
        case 'shuffle':
          if (texts.length > 0) commitResult(shuffleAll(texts, defaultRandomInts).join(' → '));
          return;
        case 'pick-n': {
          const n = Math.max(1, Math.floor(Number(countDraft) || 1));
          const picked = weightedPickN(texts, weights, n, defaultRandomInts);
          if (picked && picked.length > 0) commitResult(picked.join(', '));
          return;
        }
      }
    }

    const modeSelect = (
      <select
        className="c-input"
        style={{ width: '100%', flexShrink: 0 }}
        value={mode}
        aria-label={t('tool.random-picker.mode.label')}
        title={t('tool.random-picker.mode.label')}
        onChange={(e) => {
          if (isPickerMode(e.target.value)) setMode(e.target.value);
        }}
      >
        {PICKER_MODES.map((m) => (
          <option key={m} value={m}>
            {t(`tool.random-picker.mode.${m}`)}
          </option>
        ))}
      </select>
    );

    /** Per-mode parameter row (null for modes without parameters). */
    function paramControls(): ReactNode {
      switch (mode) {
        case 'dice':
          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-2)',
                flexShrink: 0,
              }}
            >
              <input
                className="c-input"
                value={diceSpec}
                style={{ width: '90px', textAlign: 'center', flexShrink: 0 }}
                aria-label={t('tool.random-picker.widget.diceLabel')}
                title={t('tool.random-picker.widget.diceLabel')}
                placeholder="2d6"
                onChange={(e) => setDiceSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runAction();
                }}
              />
              {diceFaces !== null && (
                <div
                  aria-hidden
                  style={{
                    fontSize: '1.8em',
                    lineHeight: 1.2,
                    letterSpacing: '0.08em',
                    textAlign: 'center',
                    fontVariantNumeric: 'tabular-nums',
                    overflowWrap: 'break-word',
                    maxWidth: '100%',
                  }}
                >
                  {diceFaces}
                </div>
              )}
            </div>
          );
        case 'number':
          return (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
              <input
                type="number"
                className="c-input"
                value={minDraft}
                style={{ width: '80px', textAlign: 'center' }}
                aria-label={t('tool.random-picker.widget.minLabel')}
                title={t('tool.random-picker.widget.minLabel')}
                onChange={(e) => setMinDraft(e.target.value)}
              />
              <span className="c-muted">–</span>
              <input
                type="number"
                className="c-input"
                value={maxDraft}
                style={{ width: '80px', textAlign: 'center' }}
                aria-label={t('tool.random-picker.widget.maxLabel')}
                title={t('tool.random-picker.widget.maxLabel')}
                onChange={(e) => setMaxDraft(e.target.value)}
              />
            </div>
          );
        case 'yes-no':
          return (
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}
            >
              <input
                type="checkbox"
                checked={withMaybe}
                style={{ accentColor: 'var(--accent)' }}
                onChange={(e) => setWithMaybe(e.target.checked)}
              />
              <span className="c-muted" style={{ fontSize: '0.85em' }}>
                {t('tool.random-picker.widget.allowMaybe')}
              </span>
            </label>
          );
        case 'pick-n':
          return (
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}
            >
              <span className="c-muted" style={{ fontSize: '0.85em' }}>
                {t('tool.random-picker.widget.countLabel')}
              </span>
              <input
                type="number"
                className="c-input"
                min={1}
                value={countDraft}
                style={{ width: '70px', textAlign: 'center' }}
                aria-label={t('tool.random-picker.widget.countLabel')}
                title={t('tool.random-picker.widget.countLabel')}
                onChange={(e) => setCountDraft(e.target.value)}
              />
            </label>
          );
        case 'coin':
          // The coin is decorative (the result is announced via the aria-live
          // result line); perspective on the wrapper gives the 3D flip depth.
          return (
            <div style={{ perspective: '400px', flexShrink: 0 }} aria-hidden>
              <div
                ref={coinRef}
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--accent)',
                  color: 'var(--accent-text)',
                  fontWeight: 700,
                  fontSize: coinFace === null ? '1.6em' : '0.95em',
                  willChange: 'transform',
                  userSelect: 'none',
                }}
              >
                {coinFace === null ? '🪙' : t(`tool.random-picker.result.${coinFace}`)}
              </div>
            </div>
          );
        default:
          return null;
      }
    }

    const actionKeys: Record<PickerMode, string> = {
      wheel: 'spin',
      dice: 'roll',
      coin: 'flip',
      number: 'drawNumber',
      'yes-no': 'ask',
      shuffle: 'shuffle',
      'pick-n': 'drawN',
    };
    const busyKeys: Partial<Record<PickerMode, string>> = {
      wheel: 'spinning',
      coin: 'flipping',
      dice: 'rolling',
    };
    const busyKey = spinning ? busyKeys[mode] : undefined;
    const actionLabel = busyKey
      ? t(`tool.random-picker.widget.${busyKey}`)
      : t(`tool.random-picker.widget.${actionKeys[mode]}`);
    const actionDisabled = spinning || (usesOptions && options.length === 0);

    const actionButton = (
      <button
        className="c-btn c-btn--primary"
        style={{ flexShrink: 0 }}
        disabled={actionDisabled}
        onClick={runAction}
      >
        {actionLabel}
      </button>
    );

    const resultLine = state.lastResult ? (
      <div
        aria-live="polite"
        style={{ textAlign: 'center', fontSize: '1.15em', fontWeight: 600, flexShrink: 0 }}
      >
        🎯 {state.lastResult}
      </div>
    ) : null;

    const invalidLine = invalid ? (
      <div style={{ color: 'var(--danger)', fontSize: '0.85em', flexShrink: 0, textAlign: 'center' }}>
        {t(
          invalid === 'dice'
            ? 'tool.random-picker.widget.invalidDice'
            : 'tool.random-picker.widget.invalidRange',
        )}
      </div>
    ) : null;

    const emptyHint = (
      <span className="c-muted" style={{ textAlign: 'center', fontSize: '0.85em' }}>
        {t('tool.random-picker.widget.empty')}
      </span>
    );

    if (variant === 'compact') {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            height: '100%',
            gap: 'var(--space-2)',
            padding: 'var(--space-2)',
            overflow: 'auto',
          }}
        >
          {modeSelect}
          {usesOptions && options.length === 0 && emptyHint}
          {invalidLine}
          {resultLine}
          {actionButton}
        </div>
      );
    }

    if (variant === 'wheel') {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            height: '100%',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
          }}
        >
          {modeSelect}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              gap: 'var(--space-2)',
            }}
          >
            {mode === 'wheel' ? (
              options.length === 0 ? (
                emptyHint
              ) : (
                <canvas
                  ref={canvasRef}
                  width={240}
                  height={240}
                  role="img"
                  aria-label={t('tool.random-picker.widget.wheelLabel')}
                  style={{ maxWidth: '100%', maxHeight: '100%' }}
                />
              )
            ) : (
              <>
                {usesOptions && options.length === 0 && emptyHint}
                {paramControls()}
              </>
            )}
          </div>
          {invalidLine}
          {resultLine}
          {actionButton}
        </div>
      );
    }

    // Default: the full view – mode select, options editor + weights, result.
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
        {modeSelect}
        {mode === 'wheel' && options.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <canvas
              ref={canvasRef}
              width={200}
              height={200}
              role="img"
              aria-label={t('tool.random-picker.widget.wheelLabel')}
              style={{ maxWidth: '100%' }}
            />
          </div>
        )}
        {usesOptions ? (
          <>
            <textarea
              className="c-input"
              style={{ flex: 1, minHeight: 0, resize: 'none', fontFamily: 'inherit' }}
              value={optionsDraft ?? texts.join('\n')}
              placeholder={t('tool.random-picker.widget.optionsPlaceholder')}
              aria-label={t('tool.random-picker.widget.optionsPlaceholder')}
              onChange={(e) => setOptionsDraft(e.target.value)}
              onBlur={() => {
                if (optionsDraft !== null) {
                  setOptions(mergeOptions(parseItems(optionsDraft), options));
                  setOptionsDraft(null);
                }
              }}
            />
            {options.length > 0 && (
              <details style={{ flexShrink: 0 }}>
                <summary className="c-muted" style={{ cursor: 'pointer', fontSize: '0.85em' }}>
                  {t('tool.random-picker.widget.advanced')}
                </summary>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                    marginTop: 'var(--space-1)',
                    maxHeight: '120px',
                    overflow: 'auto',
                  }}
                >
                  {options.map((option, i) => (
                    <label
                      key={`${option.text}-${i}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '0.85em',
                        }}
                      >
                        {option.text}
                      </span>
                      <input
                        type="range"
                        min={MIN_WEIGHT}
                        max={MAX_WEIGHT}
                        step={1}
                        value={option.weight}
                        style={{ accentColor: 'var(--accent)', width: '100px', flexShrink: 0 }}
                        aria-label={t('tool.random-picker.widget.weightLabel', { option: option.text })}
                        title={t('tool.random-picker.widget.weightLabel', { option: option.text })}
                        onChange={(e) => setWeight(i, Number(e.target.value))}
                      />
                      <span
                        className="c-muted"
                        style={{
                          fontSize: '0.85em',
                          width: '2ch',
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          flexShrink: 0,
                        }}
                      >
                        {option.weight}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            )}
            {mode === 'pick-n' && paramControls()}
          </>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-2)',
            }}
          >
            {paramControls()}
          </div>
        )}
        {invalidLine}
        {resultLine}
        {actionButton}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;

      await migrateLegacy(context.storage);

      context.commands.register({
        id: 'random-picker.pick',
        titleKey: 'tool.random-picker.command.pick',
        descriptionKey: 'tool.random-picker.command.pickDesc',
        icon: '🎯',
        params: z.object({ options: z.string().min(1).optional() }),
        selfTestParams: { options: 'alpha, beta, gamma' },
        async run({ options }): Promise<CommandResult> {
          if (options) {
            // Inline comma-separated options override the stored state (weight 1).
            const inline = parseItems(options).map((text) => ({ text, weight: 1 }));
            const picked = pickWeighted(inline);
            if (!picked) return { ok: true, messageKey: 'tool.random-picker.msg.empty' };
            return { ok: true, data: picked, messageKey: 'tool.random-picker.msg.picked' };
          }
          const state = await loadState(context.storage);
          const picked = pickWeighted(state.options);
          // Graceful when nothing is entered (also keeps diagnostics green).
          if (!picked) return { ok: true, messageKey: 'tool.random-picker.msg.empty' };
          await context.storage.set<PickerStateDoc>(STATE_DOC_ID, {
            ...state,
            lastResult: picked.pick,
          });
          return { ok: true, data: picked, messageKey: 'tool.random-picker.msg.picked' };
        },
      });

      context.commands.register({
        id: 'random-picker.roll',
        titleKey: 'tool.random-picker.command.roll',
        descriptionKey: 'tool.random-picker.command.rollDesc',
        icon: '🎲',
        params: z.object({ dice: z.string().min(2).max(8) }),
        selfTestParams: { dice: '2d6' },
        async run({ dice }): Promise<CommandResult> {
          const rolled = rollDice(dice, defaultRandomInts);
          if (!rolled) return { ok: false, messageKey: 'tool.random-picker.msg.invalidDice' };
          return { ok: true, data: rolled, messageKey: 'tool.random-picker.msg.rolled' };
        },
      });

      context.commands.register({
        id: 'random-picker.flip',
        titleKey: 'tool.random-picker.command.flip',
        descriptionKey: 'tool.random-picker.command.flipDesc',
        icon: '🪙',
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const side = coinFlip(secureRandomInt);
          return { ok: true, data: { side }, messageKey: 'tool.random-picker.msg.flipped' };
        },
      });

      context.commands.register({
        id: 'random-picker.number',
        titleKey: 'tool.random-picker.command.number',
        descriptionKey: 'tool.random-picker.command.numberDesc',
        icon: '🔢',
        params: z.object({
          min: z.number().int().min(-1_000_000_000).max(1_000_000_000),
          max: z.number().int().min(-1_000_000_000).max(1_000_000_000),
        }),
        selfTestParams: { min: 1, max: 100 },
        async run({ min, max }): Promise<CommandResult> {
          const value = randomInRange(min, max, secureRandomInt);
          if (value === null) return { ok: false, messageKey: 'tool.random-picker.msg.invalidRange' };
          return { ok: true, data: { value, min, max }, messageKey: 'tool.random-picker.msg.number' };
        },
      });

      context.commands.register({
        id: 'random-picker.context',
        titleKey: 'tool.random-picker.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const doc = await context.storage.get<PickerStateDoc>(STATE_DOC_ID);
          const state = doc ? await loadState(context.storage) : null;
          return {
            ok: true,
            data: { contextText: buildPickerContext(state, context.i18n.language) },
          };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: PickerWidget,
    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'weighted-pick': {
          for (const bad of [[], [0, 0], [1, -1], [1, 0.5]] as const) {
            if (weightedPickIndex(bad, secureRandomInt) !== null) {
              return { status: 'fail', detail: `weights ${JSON.stringify(bad)} must be rejected` };
            }
          }
          // Cumulative mapping: weights [2,1,3], target 2 falls into index 1.
          if (weightedPickIndex([2, 1, 3], () => 2) !== 1) {
            return { status: 'fail', detail: 'cumulative range mapping broken' };
          }
          const counts = [0, 0, 0];
          for (let i = 0; i < 300; i++) {
            const index = weightedPickIndex([0, 5, 1], secureRandomInt);
            if (index === null || index < 0 || index > 2) {
              return { status: 'fail', detail: `index out of bounds: ${index}` };
            }
            counts[index] = (counts[index] ?? 0) + 1;
          }
          if (counts[0] !== 0) {
            return { status: 'fail', detail: `zero-weight option picked ${counts[0]} times` };
          }
          // P(1) = 5/6 → mean 250 of 300; below 180 is >10σ off.
          if ((counts[1] ?? 0) < 180) {
            return { status: 'fail', detail: `weight-5 option only picked ${counts[1]} of 300` };
          }
          return { status: 'pass', detail: 'validation, mapping and distribution bounds ok' };
        }
        case 'migration': {
          await testCtx.storage.delete(STATE_DOC_ID);
          const legacyA: LegacyListDoc = {
            id: 'list:selftest-a',
            type: 'list',
            name: 'First',
            items: ['one', 'two'],
            removeOnPick: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          };
          const legacyB: LegacyListDoc = {
            ...legacyA,
            id: 'list:selftest-b',
            name: 'Second',
            items: ['ignored'],
            createdAt: '2026-01-02T00:00:00.000Z',
          };
          await testCtx.storage.set(legacyA.id, legacyA);
          await testCtx.storage.set(legacyB.id, legacyB);
          await migrateLegacy(testCtx.storage);
          const state = await testCtx.storage.get<PickerStateDoc>(STATE_DOC_ID);
          const leftA = await testCtx.storage.get(legacyA.id);
          const leftB = await testCtx.storage.get(legacyB.id);
          await testCtx.storage.delete(STATE_DOC_ID);
          if (leftA !== null || leftB !== null) {
            return { status: 'fail', detail: 'legacy list docs not deleted' };
          }
          const importedTexts = state?.options.map((o) => o.text).join(',');
          const weightsOk = state?.options.every((o) => o.weight === 1) ?? false;
          if (state?.mode !== 'wheel' || importedTexts !== 'one,two' || !weightsOk) {
            return { status: 'fail', detail: `bad import: ${JSON.stringify(state)}` };
          }
          return { status: 'pass', detail: 'first list imported as weight-1 options, legacy docs deleted' };
        }
        case 'pick-command': {
          const inline = await testCtx.commands.execute('random-picker.pick', {
            options: 'alpha, beta',
          });
          const inlineData = inline.data as { pick?: string } | undefined;
          if (!inline.ok || !inlineData?.pick || !['alpha', 'beta'].includes(inlineData.pick)) {
            return { status: 'fail', detail: `inline pick not a member: ${JSON.stringify(inline)}` };
          }
          const doc: PickerStateDoc = {
            id: STATE_DOC_ID,
            type: 'state',
            options: [{ text: 'solo', weight: 3 }],
            mode: 'wheel',
          };
          await testCtx.storage.set(doc.id, doc);
          const stored = await testCtx.commands.execute('random-picker.pick', {});
          const after = await testCtx.storage.get<PickerStateDoc>(STATE_DOC_ID);
          await testCtx.storage.delete(STATE_DOC_ID);
          const storedData = stored.data as { pick?: string } | undefined;
          if (!stored.ok || storedData?.pick !== 'solo') {
            return { status: 'fail', detail: `stored pick wrong: ${JSON.stringify(stored)}` };
          }
          if (after?.lastResult !== 'solo') {
            return { status: 'fail', detail: 'stored pick did not persist lastResult' };
          }
          return { status: 'pass', detail: 'inline override and stored weighted pick both work' };
        }
        case 'mode-commands': {
          const flip = await testCtx.commands.execute('random-picker.flip', {});
          const side = (flip.data as { side?: string } | undefined)?.side ?? '';
          if (!flip.ok || !['heads', 'tails'].includes(side)) {
            return { status: 'fail', detail: `bad coin flip: ${JSON.stringify(flip)}` };
          }
          const fixed = await testCtx.commands.execute('random-picker.number', { min: 5, max: 5 });
          if (!fixed.ok || (fixed.data as { value?: number } | undefined)?.value !== 5) {
            return { status: 'fail', detail: `5..5 must yield 5: ${JSON.stringify(fixed)}` };
          }
          const ranged = await testCtx.commands.execute('random-picker.number', { min: 3, max: 7 });
          const value = (ranged.data as { value?: number } | undefined)?.value;
          if (!ranged.ok || typeof value !== 'number' || value < 3 || value > 7 || !Number.isInteger(value)) {
            return { status: 'fail', detail: `3..7 out of range: ${JSON.stringify(ranged)}` };
          }
          const badDice = await testCtx.commands.execute('random-picker.roll', { dice: 'nope' });
          if (badDice.ok) return { status: 'fail', detail: 'invalid dice spec must fail' };
          const roll = await testCtx.commands.execute('random-picker.roll', { dice: '2d6' });
          const total = (roll.data as { total?: number } | undefined)?.total;
          if (!roll.ok || typeof total !== 'number' || total < 2 || total > 12) {
            return { status: 'fail', detail: `2d6 total out of range: ${JSON.stringify(roll)}` };
          }
          return { status: 'pass', detail: 'flip, number and roll commands behave' };
        }
        case 'render':
          return typeof PickerWidget === 'function' && PickerWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

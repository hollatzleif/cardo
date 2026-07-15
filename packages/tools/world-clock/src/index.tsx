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
  COMMON_TIMEZONES,
  MAX_ZONES,
  STATE_DOC_ID,
  addZone,
  addZoneParamsSchema,
  analogAngles,
  buildWorldClockContext,
  isValidTimeZone,
  offsetLabel,
  removeZone,
  zoneTime,
  type WorldClockState,
  type ZoneEntry,
} from './logic';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function getStateIn(storage: ToolStorage): Promise<WorldClockState> {
  const doc = await storage.get<WorldClockState>(STATE_DOC_ID);
  return doc ?? { id: STATE_DOC_ID, zones: [] };
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /** Small analog face: minute-resolution hands, colors via semantic tokens only. */
  function AnalogFace(props: { hour: number; minute: number; label: string }) {
    const angles = analogAngles(props.hour, props.minute);
    const hand = (angle: number, length: number, width: number, color: string) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return (
        <line
          x1={24}
          y1={24}
          x2={24 + length * Math.cos(rad)}
          y2={24 + length * Math.sin(rad)}
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
        />
      );
    };
    return (
      <svg viewBox="0 0 48 48" role="img" aria-label={props.label} style={{ width: 48, height: 48 }}>
        <circle cx={24} cy={24} r={22} fill="none" stroke="var(--border-subtle)" strokeWidth={2} />
        {hand(angles.hour, 11, 2.5, 'var(--text-primary)')}
        {hand(angles.minute, 17, 1.8, 'var(--accent)')}
        <circle cx={24} cy={24} r={1.6} fill="var(--accent)" />
      </svg>
    );
  }

  /** Day/night indicator dot (daytime = 06:00–19:59 local). */
  function DayDot(props: { isDay: boolean }) {
    return (
      <span
        title={t(props.isDay ? 'tool.world-clock.widget.day' : 'tool.world-clock.widget.night')}
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          flexShrink: 0,
          background: props.isDay ? 'var(--warning)' : 'var(--info)',
        }}
      />
    );
  }

  function WorldClockWidget(props: WidgetProps) {
    const [state, setState] = useState<WorldClockState>({ id: STATE_DOC_ID, zones: [] });
    const [now, setNow] = useState(() => new Date());
    const [tzDraft, setTzDraft] = useState('');
    const [labelDraft, setLabelDraft] = useState('');

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      setState(await getStateIn(c.storage));
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

    // Minute ticks, aligned to the wall-clock minute (spec: minute resolution).
    useEffect(() => {
      let interval: number | undefined;
      const align = window.setTimeout(() => {
        setNow(new Date());
        interval = window.setInterval(() => setNow(new Date()), 60_000);
      }, 60_000 - (Date.now() % 60_000));
      return () => {
        window.clearTimeout(align);
        if (interval !== undefined) window.clearInterval(interval);
      };
    }, []);

    const lang = ctx?.i18n.language ?? 'en';
    const zones = state.zones;
    const trimmedTz = tzDraft.trim();
    const draftInvalid = trimmedTz !== '' && !isValidTimeZone(trimmedTz);
    const full = zones.length >= MAX_ZONES;
    const datalistId = `world-clock-tz-${props.instanceId}`;

    async function add() {
      const c = ctx;
      if (!c || trimmedTz === '' || draftInvalid || full) return;
      const next = addZone(state, trimmedTz, labelDraft);
      if (!next) return;
      await c.storage.set(STATE_DOC_ID, next);
      setTzDraft('');
      setLabelDraft('');
    }

    async function remove(zone: ZoneEntry) {
      const c = ctx;
      if (!c) return;
      await c.storage.set(STATE_DOC_ID, removeZone(state, zone.id));
    }

    const removeButton = (zone: ZoneEntry) => (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.world-clock.widget.remove', { label: zone.label })}
        title={t('tool.world-clock.widget.remove', { label: zone.label })}
        style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
        onClick={() => void remove(zone)}
      >
        ×
      </button>
    );

    const renderRow = (zone: ZoneEntry) => {
      const time = zoneTime(now, zone.tz, lang);
      if (!time) return null;
      return (
        <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <DayDot isDay={time.isDay} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {zone.label}
            <span className="c-muted" style={{ fontSize: 12 }}>
              {' '}
              {time.weekday}
            </span>
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '1.1em', flexShrink: 0 }}>
            {time.hh}:{time.mm}
          </span>
          <span
            className="c-muted"
            style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
          >
            {offsetLabel(now, zone.tz)}
          </span>
          {removeButton(zone)}
        </div>
      );
    };

    const renderCell = (zone: ZoneEntry) => {
      const time = zoneTime(now, zone.tz, lang);
      if (!time) return null;
      return (
        <div
          key={zone.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            minWidth: 0,
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              maxWidth: '100%',
            }}
          >
            <DayDot isDay={time.isDay} />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
              }}
            >
              {zone.label}
            </span>
            {removeButton(zone)}
          </span>
          <span style={{ fontSize: '1.6em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
            {time.hh}:{time.mm}
          </span>
          <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {offsetLabel(now, zone.tz)}
          </span>
        </div>
      );
    };

    const renderAnalog = (zone: ZoneEntry) => {
      const time = zoneTime(now, zone.tz, lang);
      if (!time) return null;
      return (
        <div
          key={zone.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-1)',
            minWidth: 72,
          }}
        >
          <AnalogFace
            hour={time.hour}
            minute={time.minute}
            label={`${zone.label} ${time.hh}:${time.mm}`}
          />
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              maxWidth: 110,
            }}
          >
            <DayDot isDay={time.isDay} />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
              }}
            >
              {zone.label}
            </span>
            {removeButton(zone)}
          </span>
          <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {time.hh}:{time.mm}
          </span>
        </div>
      );
    };

    const zoneArea =
      zones.length === 0 ? (
        <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
          {t('tool.world-clock.widget.empty')}
        </div>
      ) : props.variant === 'grid' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 'var(--space-2)',
          }}
        >
          {zones.map(renderCell)}
        </div>
      ) : props.variant === 'analog-row' ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 'var(--space-3)',
          }}
        >
          {zones.map(renderAnalog)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          {zones.map(renderRow)}
        </div>
      );

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
        {/* Zone picker: free input, validated, with curated suggestions. */}
        {full ? (
          <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
            {t('tool.world-clock.widget.maxReached', { max: MAX_ZONES })}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
            <input
              className="c-input"
              list={datalistId}
              value={tzDraft}
              placeholder={t('tool.world-clock.widget.tzPlaceholder')}
              aria-label={t('tool.world-clock.widget.tzLabel')}
              aria-invalid={draftInvalid}
              style={{
                flex: 2,
                minWidth: 120,
                ...(draftInvalid ? { boxShadow: 'inset 0 0 0 1px var(--danger)' } : {}),
              }}
              onChange={(e) => setTzDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <datalist id={datalistId}>
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
            <input
              className="c-input"
              value={labelDraft}
              placeholder={t('tool.world-clock.widget.labelPlaceholder')}
              aria-label={t('tool.world-clock.widget.labelPlaceholder')}
              style={{ flex: 1, minWidth: 70 }}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <button
              className="c-btn c-btn--primary"
              aria-label={t('tool.world-clock.widget.add')}
              title={t('tool.world-clock.widget.add')}
              disabled={trimmedTz === '' || draftInvalid}
              style={{ flexShrink: 0 }}
              onClick={() => void add()}
            >
              +
            </button>
          </div>
        )}
        {draftInvalid ? (
          <div style={{ color: 'var(--danger)', fontSize: 12, flexShrink: 0 }}>
            {t('tool.world-clock.widget.invalidZone')}
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{zoneArea}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'world-clock.add-zone',
        titleKey: 'tool.world-clock.command.addZone',
        descriptionKey: 'tool.world-clock.command.addZoneDesc',
        icon: 'plus',
        params: addZoneParamsSchema,
        selfTestParams: { tz: 'Europe/Berlin' },
        async run(params): Promise<CommandResult> {
          const tz = params.tz.trim();
          if (!isValidTimeZone(tz)) {
            return { ok: false, messageKey: 'tool.world-clock.msg.invalidZone' };
          }
          const state = await getStateIn(context.storage);
          // Idempotent for identical tz+label (also keeps repeated diagnose
          // probes from filling the list up to the maximum).
          const label = (params.label ?? '').trim();
          const existing = state.zones.find(
            (zone) => zone.tz === tz && (label === '' || zone.label === label),
          );
          if (existing) {
            return { ok: true, data: existing, messageKey: 'tool.world-clock.msg.zoneExists' };
          }
          const next = addZone(state, tz, params.label);
          if (!next) return { ok: false, messageKey: 'tool.world-clock.msg.maxZones' };
          await context.storage.set(STATE_DOC_ID, next);
          const added = next.zones[next.zones.length - 1];
          return { ok: true, data: added, messageKey: 'tool.world-clock.msg.zoneAdded' };
        },
      });

      context.commands.register({
        id: 'world-clock.context',
        titleKey: 'tool.world-clock.command.context',
        descriptionKey: 'tool.world-clock.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const state = await getStateIn(context.storage);
          return {
            ok: true,
            data: {
              contextText: buildWorldClockContext(state.zones, new Date(), context.i18n.language),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: WorldClockWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'zones-crud': {
          // Delta-based: the scratch state doc may hold leftovers from
          // command probes. Restore the previous doc afterwards.
          const before = await testCtx.storage.get<WorldClockState>(STATE_DOC_ID);
          const base = before ?? { id: STATE_DOC_ID, zones: [] };
          const added = addZone(base, 'Asia/Tokyo', 'selftest zone');
          if (!added && base.zones.length < MAX_ZONES) {
            return { status: 'fail', detail: 'addZone rejected a valid zone' };
          }
          const probe = added ?? base;
          await testCtx.storage.set(STATE_DOC_ID, probe);
          const back = await getStateIn(testCtx.storage);
          const zone = back.zones.find((entry) => entry.label === 'selftest zone');
          if (added && (!zone || zone.tz !== 'Asia/Tokyo')) {
            await testCtx.storage.set(STATE_DOC_ID, base);
            return { status: 'fail', detail: `zone missing after roundtrip: ${JSON.stringify(back)}` };
          }
          const cleaned = zone ? removeZone(back, zone.id) : back;
          await testCtx.storage.set(STATE_DOC_ID, cleaned);
          const after = await getStateIn(testCtx.storage);
          if (zone && after.zones.some((entry) => entry.id === zone.id)) {
            return { status: 'fail', detail: 'zone still present after remove' };
          }
          if (before) await testCtx.storage.set(STATE_DOC_ID, before);
          else await testCtx.storage.delete(STATE_DOC_ID);
          return { status: 'pass', detail: 'add → read → remove roundtrip ok' };
        }
        case 'tz-validation': {
          if (!isValidTimeZone('Europe/Berlin') || !isValidTimeZone('America/New_York')) {
            return { status: 'fail', detail: 'known IANA zones must validate' };
          }
          if (isValidTimeZone('Not/AZone') || isValidTimeZone('')) {
            return { status: 'fail', detail: 'garbage zones must be rejected' };
          }
          const winter = new Date('2026-01-15T12:00:00Z');
          const berlin = zoneTime(winter, 'Europe/Berlin');
          const newYork = zoneTime(winter, 'America/New_York');
          if (!berlin || !newYork) {
            return { status: 'fail', detail: 'zoneTime returned null for valid zones' };
          }
          if (berlin.hh !== '13' || newYork.hh !== '07') {
            return {
              status: 'fail',
              detail: `expected 13:xx Berlin / 07:xx New York, got ${berlin.hh}/${newYork.hh}`,
            };
          }
          if (zoneTime(winter, 'Not/AZone') !== null) {
            return { status: 'fail', detail: 'zoneTime must be null for invalid zones' };
          }
          const offset = offsetLabel(winter, 'Europe/Berlin');
          if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
            return { status: 'fail', detail: `offsetLabel returned "${offset}"` };
          }
          return { status: 'pass', detail: 'validation, conversion and offsets verified' };
        }
        case 'render':
          return typeof WorldClockWidget === 'function' && WorldClockWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

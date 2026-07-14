import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { analogAngles, timeToWords, type ClockLang } from './logic';

const center = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  gap: 'var(--space-1)',
  textAlign: 'center',
  padding: 'var(--space-2)',
} as const;

/** Clock with several display styles, selectable via the widget variant picker. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  function ClockWidget(props: WidgetProps) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
      const timer = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(timer);
    }, []);
    const lang = ctx?.i18n.language ?? 'en';
    const wordLang: ClockLang = lang.startsWith('de') ? 'de' : 'en';

    switch (props.variant) {
      case 'analog':
        return <AnalogClock now={now} lang={lang} />;
      case 'minimal':
        return (
          <div style={center}>
            <div
              style={{
                fontSize: '3.4em',
                fontWeight: 300,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {now.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        );
      case 'mono':
        return (
          <div style={{ ...center, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
            <div
              style={{
                fontSize: '2.4em',
                letterSpacing: '0.04em',
                color: 'var(--accent)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {now.toLocaleTimeString(lang, { hour12: false })}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>
              {now.toLocaleDateString(lang, { year: 'numeric', month: '2-digit', day: '2-digit' })}
            </div>
          </div>
        );
      case 'words':
        return (
          <div style={center}>
            <div style={{ fontSize: '1.7em', fontWeight: 500, lineHeight: 1.25 }}>
              {timeToWords(now, wordLang)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>
              {now.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
          </div>
        );
      case 'digital':
      default:
        return (
          <div style={center}>
            <div style={{ fontSize: '2.2em', fontVariantNumeric: 'tabular-nums' }}>
              {now.toLocaleTimeString(lang)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
              {now.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
          </div>
        );
    }
  }

  /** SVG analog face: hour ticks + three hands, second hand in the accent color. */
  function AnalogClock({ now, lang }: { now: Date; lang: string }) {
    const { hour, minute, second } = analogAngles(now);
    const hand = (angle: number, length: number, width: number, color: string) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return (
        <line
          x1={50}
          y1={50}
          x2={50 + length * Math.cos(rad)}
          y2={50 + length * Math.sin(rad)}
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
        />
      );
    };
    return (
      <div style={center}>
        <svg
          viewBox="0 0 100 100"
          style={{ width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%' }}
          role="img"
          aria-label={now.toLocaleTimeString(lang)}
        >
          <circle cx={50} cy={50} r={48} fill="none" stroke="var(--border-subtle)" strokeWidth={2} />
          {Array.from({ length: 12 }, (_, i) => {
            const rad = ((i * 30 - 90) * Math.PI) / 180;
            return (
              <line
                key={i}
                x1={50 + 44 * Math.cos(rad)}
                y1={50 + 44 * Math.sin(rad)}
                x2={50 + 48 * Math.cos(rad)}
                y2={50 + 48 * Math.sin(rad)}
                stroke="var(--text-muted)"
                strokeWidth={i % 3 === 0 ? 2.5 : 1}
              />
            );
          })}
          {hand(hour, 26, 3.5, 'var(--text-primary)')}
          {hand(minute, 38, 2.5, 'var(--text-primary)')}
          {hand(second, 42, 1, 'var(--accent)')}
          <circle cx={50} cy={50} r={2.5} fill="var(--accent)" />
        </svg>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'clock.show-time',
        titleKey: 'tool.clock.command.showTime',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          return { ok: true, data: new Date().toISOString() };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: ClockWidget,
    async runSelfTest(testId) {
      switch (testId) {
        case 'render':
          // Uses hooks, so it cannot be invoked outside React here – the host's
          // ping check covers mounting. This verifies the export contract.
          return typeof ClockWidget === 'function' && ClockWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget is not a render function' };
        case 'time': {
          const time = new Date();
          return Number.isFinite(time.getTime())
            ? { status: 'pass' }
            : { status: 'fail', detail: 'system clock returned invalid time' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

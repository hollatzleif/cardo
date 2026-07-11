import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';

/** Clock – the simplest possible tool. Proof that widgets render and update. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  function ClockWidget(_props: WidgetProps) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
      const timer = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(timer);
    }, []);
    const lang = ctx?.i18n.language ?? 'en';
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-1)',
        }}
      >
        <div style={{ fontSize: '2.2em', fontVariantNumeric: 'tabular-nums' }}>
          {now.toLocaleTimeString(lang)}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
          {now.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
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

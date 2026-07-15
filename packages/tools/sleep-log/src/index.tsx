import { useEffect, useState } from 'react';
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

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function Widget(props: WidgetProps) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      setReady(ctx !== null);
    }, []);
    // Variant switch: extend via manifest widgets[].variants + cases here.
    switch (props.variant) {
      default:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', height: '100%' }}>
            <strong>{t('tool.sleep-log.name')}</strong>
            <span className="c-muted">{ready ? t('tool.sleep-log.widget.empty') : '…'}</span>
          </div>
        );
    }
  }

  async function registerCommands(context: ToolContext): Promise<void> {
    context.commands.register({
      id: 'sleep-log.context',
      titleKey: 'tool.sleep-log.command.context',
      palette: false,
      params: z.object({}),
      selfTestParams: {},
      async run(): Promise<CommandResult> {
        // Summarize the tool's current state for the assistant prompt.
        return { ok: true, data: { contextText: t('tool.sleep-log.widget.empty') } };
      },
    });
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;
      await registerCommands(context);
    },
    deactivate() {
      ctx = null;
    },
    Widget,
    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        case 'storage': {
          await testCtx.storage.set('selftest', { probe: true });
          const doc = await testCtx.storage.get<{ probe: boolean }>('selftest');
          await testCtx.storage.delete('selftest');
          return doc?.probe === true
            ? { status: 'pass' }
            : { status: 'fail', detail: 'storage roundtrip failed' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

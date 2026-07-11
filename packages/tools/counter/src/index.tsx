import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';

type CounterDoc = { value: number; updatedAt: string };
const DOC_ID = 'main';

/** Counter – proof that namespaced storage persists and change events flow. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  async function readValue(): Promise<number> {
    const doc = await ctx?.storage.get<CounterDoc>(DOC_ID);
    return doc?.value ?? 0;
  }

  async function writeValue(value: number): Promise<void> {
    await ctx?.storage.set<CounterDoc>(DOC_ID, { value, updatedAt: new Date().toISOString() });
  }

  function CounterWidget(_props: WidgetProps) {
    const [count, setCount] = useState<number | null>(null);
    useEffect(() => {
      let mounted = true;
      readValue().then((v) => mounted && setCount(v));
      const unsub = ctx?.storage.subscribe(() => {
        readValue().then((v) => mounted && setCount(v));
      });
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ fontSize: '2.6em', fontVariantNumeric: 'tabular-nums' }}>
          {count ?? '…'}
        </div>
        <button
          className="c-btn c-btn--primary"
          onClick={async () => writeValue((await readValue()) + 1)}
        >
          +1
        </button>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'counter.increment',
        titleKey: 'tool.counter.command.increment',
        params: z.object({ by: z.number().int().default(1) }),
        selfTestParams: { by: 1 },
        async run({ by }) {
          await writeValue((await readValue()) + (by ?? 1));
          return { ok: true, data: await readValue() };
        },
      });
      context.commands.register({
        id: 'counter.reset',
        titleKey: 'tool.counter.command.reset',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await writeValue(0);
          return { ok: true };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: CounterWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'storage': {
          const probe = { value: 41, updatedAt: new Date().toISOString() };
          await testCtx.storage.set('selftest-probe', probe);
          const roundtrip = await testCtx.storage.get<CounterDoc>('selftest-probe');
          await testCtx.storage.delete('selftest-probe');
          return roundtrip?.value === 41
            ? { status: 'pass' }
            : { status: 'fail', detail: `expected 41, got ${JSON.stringify(roundtrip)}` };
        }
        case 'commands': {
          // ctx currently points at the scratch context (diagnose activates us there).
          await writeValue(0);
          await writeValue((await readValue()) + 5);
          const value = await readValue();
          return value === 5
            ? { status: 'pass' }
            : { status: 'fail', detail: `expected 5, got ${value}` };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

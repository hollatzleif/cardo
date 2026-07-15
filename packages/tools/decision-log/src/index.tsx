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
import {
  SECTION_ORDER,
  buildDecisionContext,
  decisionFileName,
  parseDecision,
  serializeDecision,
  sortByDateDesc,
  todayIso,
  type Decision,
  type DecisionSection,
} from './logic';
import { createDecisionStore, type DecisionStore } from './store';

/*
 * Decision log – searchable log of decisions, stored as markdown files
 * ("decision-YYYY-MM-DD-<slug>.md" with Kontext/Optionen/Entscheidung/
 * Begründung sections) via the files API; falls back to storage docs when
 * no file backend exists (scratch/self-test context).
 */

/** Tiny UI doc: widgets reload on file writes + search focuses a decision. */
const UI_DOC_ID = 'ui';
type UiDoc = { open?: string; at?: number };

type LoadedDecision = { name: string; decision: Decision };

async function loadDecisions(store: DecisionStore): Promise<LoadedDecision[]> {
  const parsed: Array<{ name: string; decision: Decision }> = [];
  for (const doc of await store.list()) {
    const decision = parseDecision(doc.markdown);
    if (decision) parsed.push({ name: doc.name, decision });
  }
  const order = sortByDateDesc(parsed.map((p) => ({ ...p.decision, name: p.name })));
  return order.map(({ name }) => parsed.find((p) => p.name === name) as LoadedDecision);
}

/** Shared by the add command and self-tests. Returns the document name. */
async function addDecisionIn(
  store: DecisionStore,
  language: string,
  input: { title: string; decision: string; rationale?: string; context?: string; options?: string },
  now: Date = new Date(),
): Promise<string> {
  const full: Decision = {
    title: input.title.trim(),
    date: todayIso(now),
    context: input.context?.trim() ?? '',
    options: input.options?.trim() ?? '',
    decision: input.decision.trim(),
    rationale: input.rationale?.trim() ?? '',
  };
  const name = decisionFileName(full.date, full.title);
  await store.add(name, serializeDecision(full, language));
  return name;
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  let store: DecisionStore | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function useDecisions(): { decisions: LoadedDecision[]; focused: string | null } {
    const [decisions, setDecisions] = useState<LoadedDecision[]>([]);
    const [focused, setFocused] = useState<string | null>(null);
    useEffect(() => {
      let mounted = true;
      const reload = async () => {
        if (!store) return;
        const loaded = await loadDecisions(store);
        if (mounted) setDecisions(loaded);
      };
      const applyUi = async () => {
        const ui = await ctx?.storage.get<UiDoc>(UI_DOC_ID);
        if (mounted) setFocused(ui?.open ?? null);
      };
      void reload();
      void applyUi();
      // File writes don't emit storage events – the add command and the
      // search provider touch the 'ui' doc instead, so widgets stay fresh
      // in both backends.
      const unsub = ctx?.storage.subscribe(() => {
        void reload();
        void applyUi();
      });
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);
    return { decisions, focused };
  }

  function SectionView(props: { decision: Decision }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {SECTION_ORDER.map((section: DecisionSection) => {
          const body = props.decision[section];
          if (!body) return null;
          return (
            <div key={section} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-muted)',
                }}
              >
                {t(`tool.decision-log.section.${section}`)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontSize: 13 }}>
                {body}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function AddForm(props: { onDone: () => void }) {
    const [title, setTitle] = useState('');
    const [contextDraft, setContextDraft] = useState('');
    const [options, setOptions] = useState('');
    const [decisionDraft, setDecisionDraft] = useState('');
    const [rationale, setRationale] = useState('');
    const valid = title.trim().length > 0 && decisionDraft.trim().length > 0;

    async function submit() {
      if (!valid || !ctx) return;
      const params: Record<string, string> = {
        title: title.trim(),
        decision: decisionDraft.trim(),
      };
      if (contextDraft.trim()) params.context = contextDraft.trim();
      if (options.trim()) params.options = options.trim();
      if (rationale.trim()) params.rationale = rationale.trim();
      const result = await ctx.commands.execute('decision-log.add', params);
      if (result.ok) props.onDone();
    }

    const area = (labelKey: string, value: string, set: (v: string) => void) => (
      <textarea
        className="c-input"
        value={value}
        rows={2}
        placeholder={t(labelKey)}
        aria-label={t(labelKey)}
        style={{ resize: 'vertical', fontSize: 13 }}
        onChange={(e) => set(e.target.value)}
      />
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flexShrink: 0 }}>
        <input
          className="c-input"
          autoFocus
          value={title}
          placeholder={t('tool.decision-log.form.title')}
          aria-label={t('tool.decision-log.form.title')}
          onChange={(e) => setTitle(e.target.value)}
        />
        {area('tool.decision-log.form.context', contextDraft, setContextDraft)}
        {area('tool.decision-log.form.options', options, setOptions)}
        {area('tool.decision-log.form.decision', decisionDraft, setDecisionDraft)}
        {area('tool.decision-log.form.rationale', rationale, setRationale)}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <button className="c-btn c-btn--ghost" onClick={props.onDone}>
            {t('tool.decision-log.form.cancel')}
          </button>
          <button className="c-btn c-btn--primary" disabled={!valid} onClick={() => void submit()}>
            {t('tool.decision-log.form.save')}
          </button>
        </div>
      </div>
    );
  }

  function Empty() {
    return (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.decision-log.widget.empty')}
      </div>
    );
  }

  function LogVariant() {
    const { decisions, focused } = useDecisions();
    const [adding, setAdding] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const open = expanded ?? focused;

    return (
      <>
        {adding ? (
          <AddForm onDone={() => setAdding(false)} />
        ) : (
          <button className="c-btn" style={{ flexShrink: 0 }} onClick={() => setAdding(true)}>
            + {t('tool.decision-log.widget.add')}
          </button>
        )}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          {decisions.length === 0 ? <Empty /> : null}
          {decisions.map(({ name, decision }) => {
            const isOpen = name === open;
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 'var(--radius-sm)',
                  ...(name === focused ? { boxShadow: 'inset 0 0 0 1px var(--accent)' } : {}),
                }}
              >
                <button
                  className="c-btn c-btn--ghost"
                  aria-expanded={isOpen}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-2)',
                    justifyContent: 'flex-start',
                    padding: 'var(--space-1) var(--space-2)',
                    minWidth: 0,
                  }}
                  onClick={() => setExpanded((current) => (current === name ? null : name))}
                >
                  <span
                    className="c-muted"
                    style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                  >
                    {decision.date}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {decision.title}
                  </span>
                </button>
                {isOpen ? (
                  <div style={{ padding: 'var(--space-2)', paddingTop: 0 }}>
                    <SectionView decision={decision} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  function DetailVariant() {
    const { decisions, focused } = useDecisions();
    const shown = decisions.find((d) => d.name === focused) ?? decisions[0];
    if (!shown) return <Empty />;
    return (
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
        <div style={{ fontWeight: 600, overflowWrap: 'break-word' }}>{shown.decision.title}</div>
        <div className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {shown.decision.date}
        </div>
        <SectionView decision={shown.decision} />
      </div>
    );
  }

  function CompactVariant() {
    const { decisions } = useDecisions();
    const latest = decisions[0];
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          gap: 'var(--space-1)',
          textAlign: 'center',
          minWidth: 0,
        }}
      >
        <div style={{ fontSize: '1.8em', fontVariantNumeric: 'tabular-nums' }}>{decisions.length}</div>
        <div className="c-muted" style={{ fontSize: 12 }}>
          {t('tool.decision-log.widget.count', { count: decisions.length })}
        </div>
        {latest ? (
          <div
            style={{
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 13,
            }}
            title={latest.decision.title}
          >
            {latest.decision.date} · {latest.decision.title}
          </div>
        ) : null}
      </div>
    );
  }

  function Widget(props: WidgetProps) {
    const inner =
      props.variant === 'detail' ? (
        <DetailVariant />
      ) : props.variant === 'compact' ? (
        <CompactVariant />
      ) : (
        <LogVariant />
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
        {inner}
      </div>
    );
  }

  /* ── Tool object ────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;
      store = createDecisionStore(context.files, context.storage);

      context.commands.register({
        id: 'decision-log.add',
        titleKey: 'tool.decision-log.command.add',
        descriptionKey: 'tool.decision-log.command.addDesc',
        icon: 'plus',
        params: z.object({
          title: z.string().min(1),
          decision: z.string().min(1),
          rationale: z.string().optional(),
          context: z.string().optional(),
          options: z.string().optional(),
        }),
        selfTestParams: {
          title: 'Cardo self-test decision',
          decision: 'Keep the fallback store',
        },
        async run(params): Promise<CommandResult> {
          const s = store ?? createDecisionStore(context.files, context.storage);
          const name = await addDecisionIn(s, context.i18n.language, params);
          // Nudge widgets to reload (file writes emit no storage events).
          await context.storage.set<UiDoc>(UI_DOC_ID, { at: Date.now() });
          return { ok: true, data: { name }, messageKey: 'tool.decision-log.msg.created' };
        },
      });

      // Assistant "current state" provider (see todo.context).
      context.commands.register({
        id: 'decision-log.context',
        titleKey: 'tool.decision-log.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const s = store ?? createDecisionStore(context.files, context.storage);
          const decisions = await loadDecisions(s);
          return {
            ok: true,
            data: {
              contextText: buildDecisionContext(
                decisions.map((d) => d.decision),
                context.i18n.language,
              ),
            },
          };
        },
      });

      // Global search over decision titles: picking a result focuses the
      // decision in the log/detail widgets via the shared 'ui' doc.
      context.search.register(async (query) => {
        const q = query.trim().toLowerCase();
        if (!q || !store) return [];
        const decisions = await loadDecisions(store);
        return decisions
          .filter((d) => d.decision.title.toLowerCase().includes(q))
          .slice(0, 5)
          .map((d) => ({
            title: d.decision.title,
            subtitle: d.decision.date,
            icon: '⚖',
            action: async () => {
              await context.storage.set<UiDoc>(UI_DOC_ID, { open: d.name, at: Date.now() });
            },
          }));
      });
    },

    deactivate() {
      ctx = null;
      store = null;
    },

    Widget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'roundtrip': {
          const probe: Decision = {
            title: 'Größte Änderung: "jetzt" & <hier>',
            date: '2026-07-15',
            context: 'Mehrzeiliger\nKontext',
            options: '- a\n- b',
            decision: 'Wir machen a.',
            rationale: 'Erste Zeile.\n\nZweiter Absatz mit Umlauten: äöüß.',
          };
          for (const lang of ['de', 'en']) {
            const back = parseDecision(serializeDecision(probe, lang));
            if (!back || JSON.stringify(back) !== JSON.stringify(probe)) {
              return {
                status: 'fail',
                detail: `${lang} round-trip mismatch: ${JSON.stringify(back)}`,
              };
            }
          }
          return { status: 'pass', detail: 'serialize → parse stable in de and en' };
        }
        case 'crud': {
          // Explicitly exercises the storage FALLBACK store (files may be
          // undefined in the scratch context anyway).
          const s = createDecisionStore(undefined, testCtx.storage);
          const name = await addDecisionIn(
            s,
            'de',
            { title: 'Selftest CRUD', decision: 'Ja', rationale: 'Weil.' },
            new Date(2026, 6, 15),
          );
          const listed = await s.list();
          const doc = listed.find((d) => d.name === name);
          await s.remove(name);
          const gone = (await s.list()).some((d) => d.name === name);
          if (!doc) return { status: 'fail', detail: `"${name}" missing from list()` };
          const parsed = parseDecision(doc.markdown);
          if (parsed?.title !== 'Selftest CRUD' || parsed.decision !== 'Ja') {
            return { status: 'fail', detail: `parsed mismatch: ${JSON.stringify(parsed)}` };
          }
          if (name !== 'decision-2026-07-15-selftest-crud.md') {
            return { status: 'fail', detail: `unexpected file name "${name}"` };
          }
          if (gone) return { status: 'fail', detail: 'document still listed after remove' };
          return { status: 'pass', detail: 'add → list → parse → remove roundtrip ok' };
        }
        case 'render': {
          if (typeof Widget !== 'function' || Widget.length > 1) {
            return { status: 'fail', detail: 'Widget export contract violated' };
          }
          const text = buildDecisionContext([{ title: 'X', date: '2026-01-01' }], 'en');
          if (!text.includes('«X» (2026-01-01)')) {
            return { status: 'fail', detail: `context text malformed: ${text}` };
          }
          return { status: 'pass', detail: 'widget contract and context builder ok' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

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
  addExpenseParamsSchema,
  applyTransfers,
  balances,
  buildExpensesContext,
  formatCents,
  makeId,
  settleUp,
  splitList,
  splitShares,
  todayIso,
  type ExpenseDoc,
  type GroupDoc,
  type Transfer,
} from './logic';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryGroupsIn(storage: ToolStorage): Promise<GroupDoc[]> {
  const groups = await storage.query<GroupDoc>({
    where: [{ field: 'type', op: '=', value: 'group' }],
  });
  return [...groups].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
}

async function queryExpensesIn(storage: ToolStorage, groupId?: string): Promise<ExpenseDoc[]> {
  const where: Array<{ field: string; op: '='; value: unknown }> = [
    { field: 'type', op: '=', value: 'expense' },
  ];
  if (groupId) where.push({ field: 'groupId', op: '=', value: groupId });
  const expenses = await storage.query<ExpenseDoc>({ where });
  // Newest first (date, then id as tiebreaker for same-day entries).
  return [...expenses].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

/** Group by (case-insensitive) name or doc id; created on demand with `seedMembers`. */
async function findOrCreateGroupIn(
  storage: ToolStorage,
  ref: string,
  seedMembers: string[],
): Promise<GroupDoc> {
  const direct = await storage.get<GroupDoc>(ref);
  if (direct) return direct;
  const all = await queryGroupsIn(storage);
  const byName = all.find((g) => g.name.toLowerCase() === ref.trim().toLowerCase());
  if (byName) return byName;
  const created: GroupDoc = {
    id: makeId('group'),
    type: 'group',
    name: ref.trim(),
    members: seedMembers,
    createdAt: new Date().toISOString(),
  };
  await storage.set(created.id, created);
  return created;
}

/**
 * Adds an expense: resolves (or creates) the group, unions payer +
 * participants into its member list, defaults participants to all members.
 */
async function addExpenseIn(
  storage: ToolStorage,
  input: {
    group: string;
    payer: string;
    amount: number;
    description: string;
    participants: string[];
    date?: string;
  },
): Promise<{ group: GroupDoc; expense: ExpenseDoc }> {
  const payer = input.payer.trim();
  // Case-insensitively deduped – the payer may also appear in participants.
  const seedMembers = splitList([payer, ...input.participants].join(','));
  let group = await findOrCreateGroupIn(storage, input.group, seedMembers);
  const missing = [payer, ...input.participants].filter(
    (name) => !group.members.some((member) => member.toLowerCase() === name.toLowerCase()),
  );
  if (missing.length > 0) {
    group = { ...group, members: [...group.members, ...missing] };
    await storage.set(group.id, group);
  }
  const expense: ExpenseDoc = {
    id: makeId('expense'),
    type: 'expense',
    groupId: group.id,
    payer,
    amount: input.amount,
    description: input.description.trim(),
    participants: input.participants,
    date: input.date ?? todayIso(),
  };
  await storage.set(expense.id, expense);
  return { group, expense };
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function SharedExpensesWidget(props: WidgetProps) {
    const [groups, setGroups] = useState<GroupDoc[]>([]);
    const [expenses, setExpenses] = useState<ExpenseDoc[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string>('');
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [groupName, setGroupName] = useState('');
    const [groupMembers, setGroupMembers] = useState('');
    const [payer, setPayer] = useState('');
    const [amount, setAmount] = useState('');
    const [description, setDescription] = useState('');
    const [participants, setParticipants] = useState('');

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [gs, es] = await Promise.all([queryGroupsIn(c.storage), queryExpensesIn(c.storage)]);
      setGroups(gs);
      setExpenses(es);
      setActiveGroupId((prev) => (gs.some((g) => g.id === prev) ? prev : (gs[0]?.id ?? '')));
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

    const lang = ctx?.i18n.language ?? 'en';
    const group = groups.find((g) => g.id === activeGroupId) ?? null;
    const groupExpenses = group ? expenses.filter((e) => e.groupId === group.id) : [];
    const balance = group ? balances(groupExpenses, group.members) : {};
    const transfers = settleUp(balance);

    async function createGroup() {
      const c = ctx;
      const name = groupName.trim();
      const members = splitList(groupMembers);
      if (!c || !name || members.length === 0) return;
      const created: GroupDoc = {
        id: makeId('group'),
        type: 'group',
        name,
        members,
        createdAt: new Date().toISOString(),
      };
      await c.storage.set(created.id, created);
      setGroupName('');
      setGroupMembers('');
      setShowNewGroup(false);
      setActiveGroupId(created.id);
    }

    async function addExpense() {
      const c = ctx;
      const parsedAmount = Number(amount.replace(',', '.'));
      // The select shows the first member before any interaction – mirror that.
      const effectivePayer = payer || group?.members[0] || '';
      if (!c || !group || !effectivePayer || !description.trim()) return;
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
      await addExpenseIn(c.storage, {
        group: group.id,
        payer: effectivePayer,
        amount: parsedAmount,
        description,
        participants: splitList(participants),
      });
      setAmount('');
      setDescription('');
      setParticipants('');
    }

    async function removeExpense(expense: ExpenseDoc) {
      await ctx?.storage.delete(expense.id);
    }

    /** "erledigt": record the transfer as a balancing expense (payer → creditor). */
    async function settleTransfer(transfer: Transfer) {
      const c = ctx;
      if (!c || !group) return;
      await addExpenseIn(c.storage, {
        group: group.id,
        payer: transfer.from,
        amount: transfer.amountCents / 100,
        description: t('tool.shared-expenses.widget.settlementDescription', {
          from: transfer.from,
          to: transfer.to,
        }),
        participants: [transfer.to],
      });
    }

    const groupBar = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <select
          className="c-input"
          value={activeGroupId}
          aria-label={t('tool.shared-expenses.widget.groupLabel')}
          title={t('tool.shared-expenses.widget.groupLabel')}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setActiveGroupId(e.target.value)}
        >
          {groups.length === 0 ? (
            <option value="">{t('tool.shared-expenses.widget.noGroups')}</option>
          ) : null}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.shared-expenses.widget.newGroup')}
          title={t('tool.shared-expenses.widget.newGroup')}
          aria-expanded={showNewGroup}
          style={{ flexShrink: 0 }}
          onClick={() => setShowNewGroup((s) => !s)}
        >
          +
        </button>
      </div>
    );

    const newGroupForm = showNewGroup ? (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          className="c-input"
          value={groupName}
          placeholder={t('tool.shared-expenses.widget.groupNamePlaceholder')}
          aria-label={t('tool.shared-expenses.widget.groupNamePlaceholder')}
          style={{ flex: 1, minWidth: 80 }}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <input
          className="c-input"
          value={groupMembers}
          placeholder={t('tool.shared-expenses.widget.membersPlaceholder')}
          aria-label={t('tool.shared-expenses.widget.membersPlaceholder')}
          style={{ flex: 2, minWidth: 120 }}
          onChange={(e) => setGroupMembers(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createGroup();
          }}
        />
        <button
          className="c-btn c-btn--primary"
          style={{ flexShrink: 0 }}
          onClick={() => void createGroup()}
        >
          {t('tool.shared-expenses.widget.createGroup')}
        </button>
      </div>
    ) : null;

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t(
          groups.length === 0
            ? 'tool.shared-expenses.widget.emptyGroups'
            : 'tool.shared-expenses.widget.emptyExpenses',
        )}
      </div>
    );

    let body;
    if (!group) {
      body = empty;
    } else if (props.variant === 'log') {
      const addForm = (
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
          <select
            className="c-input"
            value={payer || (group.members[0] ?? '')}
            aria-label={t('tool.shared-expenses.widget.payerLabel')}
            title={t('tool.shared-expenses.widget.payerLabel')}
            style={{ width: 'auto', flexShrink: 0 }}
            onChange={(e) => setPayer(e.target.value)}
          >
            {group.members.map((member) => (
              <option key={member} value={member}>
                {member}
              </option>
            ))}
          </select>
          <input
            className="c-input"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={amount}
            placeholder={t('tool.shared-expenses.widget.amountLabel')}
            aria-label={t('tool.shared-expenses.widget.amountLabel')}
            style={{ width: 76, textAlign: 'right' }}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="c-input"
            value={description}
            placeholder={t('tool.shared-expenses.widget.descriptionPlaceholder')}
            aria-label={t('tool.shared-expenses.widget.descriptionPlaceholder')}
            style={{ flex: 1, minWidth: 90 }}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addExpense();
            }}
          />
          <input
            className="c-input"
            value={participants}
            placeholder={t('tool.shared-expenses.widget.participantsPlaceholder')}
            aria-label={t('tool.shared-expenses.widget.participantsPlaceholder')}
            title={t('tool.shared-expenses.widget.participantsHint')}
            style={{ flex: 1, minWidth: 90 }}
            onChange={(e) => setParticipants(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addExpense();
            }}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.shared-expenses.widget.addExpense')}
            title={t('tool.shared-expenses.widget.addExpense')}
            style={{ flexShrink: 0 }}
            onClick={() => void addExpense()}
          >
            +
          </button>
        </div>
      );
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', height: '100%' }}>
          {addForm}
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
            {groupExpenses.length === 0
              ? empty
              : groupExpenses.map((expense) => (
                  <div
                    key={expense.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {expense.description}
                      <span className="c-muted" style={{ fontSize: 12 }}>
                        {' '}
                        · {expense.payer}
                      </span>
                    </span>
                    <span
                      className="c-muted"
                      style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                    >
                      {expense.date}
                    </span>
                    <span
                      style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                    >
                      {formatCents(Math.round(expense.amount * 100), lang)}
                    </span>
                    <button
                      className="c-btn c-btn--ghost"
                      aria-label={t('tool.shared-expenses.widget.deleteExpense', {
                        description: expense.description,
                      })}
                      title={t('tool.shared-expenses.widget.deleteExpense', {
                        description: expense.description,
                      })}
                      style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
                      onClick={() => void removeExpense(expense)}
                    >
                      ×
                    </button>
                  </div>
                ))}
          </div>
        </div>
      );
    } else if (props.variant === 'settle') {
      body =
        transfers.length === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            {t('tool.shared-expenses.widget.allSettled')}
          </div>
        ) : (
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
            {transfers.map((transfer) => (
              <div
                key={`${transfer.from}->${transfer.to}`}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {transfer.from} → {transfer.to}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {formatCents(transfer.amountCents, lang)}
                </span>
                <button
                  className="c-btn c-btn--ghost"
                  style={{ flexShrink: 0, color: 'var(--success)', fontSize: 12 }}
                  onClick={() => void settleTransfer(transfer)}
                >
                  {t('tool.shared-expenses.widget.markSettled')}
                </button>
              </div>
            ))}
          </div>
        );
    } else {
      // Default variant: balances (per-member bars).
      const maxAbs = Math.max(1, ...Object.values(balance).map((cents) => Math.abs(cents)));
      body =
        group.members.length === 0 ? (
          empty
        ) : (
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
            {Object.entries(balance).map(([name, cents]) => (
              <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {name}
                  </span>
                  <span
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      flexShrink: 0,
                      color:
                        cents > 0 ? 'var(--success)' : cents < 0 ? 'var(--danger)' : 'var(--text-muted)',
                    }}
                  >
                    {formatCents(cents, lang)}
                  </span>
                </div>
                <div
                  aria-hidden
                  style={{
                    height: 4,
                    borderRadius: 999,
                    background: 'var(--border-subtle)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((Math.abs(cents) / maxAbs) * 100)}%`,
                      height: '100%',
                      borderRadius: 999,
                      background: cents >= 0 ? 'var(--success)' : 'var(--danger)',
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </div>
            ))}
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
        {groupBar}
        {newGroupForm}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{body}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'shared-expenses.add',
        titleKey: 'tool.shared-expenses.command.add',
        descriptionKey: 'tool.shared-expenses.command.addDesc',
        icon: 'plus',
        params: addExpenseParamsSchema,
        selfTestParams: {
          group: 'Cardo self-test group',
          payer: 'Anna',
          amount: 12,
          description: 'Cardo self-test expense',
          participants: 'Anna, Ben',
        },
        async run(params): Promise<CommandResult> {
          const { expense } = await addExpenseIn(context.storage, {
            group: params.group,
            payer: params.payer,
            amount: params.amount,
            description: params.description,
            participants: splitList(params.participants),
          });
          return { ok: true, data: expense, messageKey: 'tool.shared-expenses.msg.added' };
        },
      });

      context.commands.register({
        id: 'shared-expenses.context',
        titleKey: 'tool.shared-expenses.command.context',
        descriptionKey: 'tool.shared-expenses.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [groups, expenses] = await Promise.all([
            queryGroupsIn(context.storage),
            queryExpensesIn(context.storage),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildExpensesContext(groups, expenses, context.i18n.language),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: SharedExpensesWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'balance-math': {
          const members = ['Anna', 'Ben', 'Cleo'];
          const shares = splitShares(1000, members, members);
          const total = Object.values(shares).reduce((acc, v) => acc + v, 0);
          if (total !== 1000 || shares['Anna'] !== 334 || shares['Ben'] !== 333) {
            return { status: 'fail', detail: `10.00/3 split wrong: ${JSON.stringify(shares)}` };
          }
          const balance = balances(
            [
              {
                id: 'expense:probe',
                type: 'expense',
                groupId: 'group:probe',
                payer: 'Anna',
                amount: 10,
                description: 'probe',
                participants: [],
                date: '2026-01-01',
              },
            ],
            members,
          );
          const sum = Object.values(balance).reduce((acc, v) => acc + v, 0);
          if (sum !== 0 || balance['Anna'] !== 666) {
            return { status: 'fail', detail: `balances wrong: ${JSON.stringify(balance)}` };
          }
          return { status: 'pass', detail: 'cent-exact split and Σ ≡ 0 verified' };
        }
        case 'settle-clears': {
          // Through storage: seed expenses, settle each suggested transfer as
          // a balancing expense, verify every balance ends at exactly 0.
          const groupName = `selftest-settle-${Date.now().toString(36)}`;
          const first = await addExpenseIn(testCtx.storage, {
            group: groupName,
            payer: 'Anna',
            amount: 10,
            description: 'probe pizza',
            participants: ['Anna', 'Ben', 'Cleo'],
          });
          await addExpenseIn(testCtx.storage, {
            group: first.group.id,
            payer: 'Ben',
            amount: 4.5,
            description: 'probe coffee',
            participants: ['Ben', 'Cleo'],
          });
          const groupId = first.group.id;
          const cleanup = async () => {
            const created = await queryExpensesIn(testCtx.storage, groupId);
            await Promise.all(created.map((e) => testCtx.storage.delete(e.id)));
            await testCtx.storage.delete(groupId);
          };
          try {
            const group = await testCtx.storage.get<GroupDoc>(groupId);
            if (!group) return { status: 'fail', detail: 'probe group not readable' };
            const before = balances(await queryExpensesIn(testCtx.storage, groupId), group.members);
            const transfers = settleUp(before);
            if (transfers.length === 0) {
              return { status: 'fail', detail: 'expected open transfers before settling' };
            }
            const cleared = applyTransfers(before, transfers);
            for (const transfer of transfers) {
              await addExpenseIn(testCtx.storage, {
                group: groupId,
                payer: transfer.from,
                amount: transfer.amountCents / 100,
                description: 'probe settlement',
                participants: [transfer.to],
              });
            }
            const after = balances(await queryExpensesIn(testCtx.storage, groupId), group.members);
            const openAfter = Object.values(after).filter((cents) => cents !== 0);
            const openCleared = Object.values(cleared).filter((cents) => cents !== 0);
            if (openAfter.length > 0 || openCleared.length > 0) {
              return {
                status: 'fail',
                detail: `balances not cleared: ${JSON.stringify(after)}`,
              };
            }
            return {
              status: 'pass',
              detail: `${transfers.length} transfers cleared all balances via storage`,
            };
          } finally {
            await cleanup();
          }
        }
        case 'crud': {
          const { group, expense } = await addExpenseIn(testCtx.storage, {
            group: `selftest-crud-${Date.now().toString(36)}`,
            payer: 'Anna',
            amount: 7.77,
            description: 'probe crud',
            participants: ['Anna', 'Ben'],
          });
          const backExpense = await testCtx.storage.get<ExpenseDoc>(expense.id);
          const backGroup = await testCtx.storage.get<GroupDoc>(group.id);
          await testCtx.storage.delete(expense.id);
          await testCtx.storage.delete(group.id);
          const gone = await testCtx.storage.get<ExpenseDoc>(expense.id);
          if (
            !backExpense ||
            backExpense.amount !== 7.77 ||
            backExpense.payer !== 'Anna' ||
            backExpense.groupId !== group.id
          ) {
            return { status: 'fail', detail: `expense roundtrip mismatch: ${JSON.stringify(backExpense)}` };
          }
          if (!backGroup || backGroup.members.join(',') !== 'Anna,Ben') {
            return { status: 'fail', detail: `group members wrong: ${JSON.stringify(backGroup)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'expense still present after delete' };
          return { status: 'pass', detail: 'group+expense create → read → delete roundtrip ok' };
        }
        case 'render':
          return typeof SharedExpensesWidget === 'function' && SharedExpensesWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}

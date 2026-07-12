import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@cardo/plugin-api';
import { executeProposals, parseProposals, type AssistantProposal } from './proposals';

const has = (id: string) => id === 'todo.create' || id === 'calendar.addEvent';

describe('parseProposals', () => {
  it('accepts a valid response', () => {
    const raw = JSON.stringify({
      reply: 'Alles klar!',
      proposals: [
        { command: 'todo.create', params: { title: 'Milch kaufen' }, summary: 'Erstellt ein To-do.' },
      ],
      memory: ['kauft freitags ein'],
    });
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.reply).toBe('Alles klar!');
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.params).toEqual({ title: 'Milch kaufen' });
    expect(parsed.memory).toEqual(['kauft freitags ein']);
    expect(parsed.delegate).toEqual([]);
    expect(parsed.forget).toEqual([]);
  });

  it('strips markdown fences and surrounding chatter', () => {
    const raw =
      '```json\n{"reply":"ok","proposals":[{"command":"todo.create","params":{},"summary":"s"}],"memory":[]}\n```';
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.proposals).toHaveLength(1);
  });

  it('flags garbage with parseError and returns nothing', () => {
    const parsed = parseProposals('Sorry, I cannot help with that.', has);
    expect(parsed.parseError).toBe(true);
    expect(parsed.proposals).toEqual([]);
    expect(parsed.memory).toEqual([]);
    expect(parsed.delegate).toEqual([]);
    expect(parsed.forget).toEqual([]);
  });

  it('filters proposals with unknown commands without flagging an error', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      proposals: [
        { command: 'system.wipeEverything', params: {}, summary: 'evil' },
        { command: 'todo.create', params: { title: 'x' }, summary: 'fine' },
      ],
      memory: [],
    });
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.command).toBe('todo.create');
  });

  it('survives hostile shapes (non-array proposals, non-string memory)', () => {
    const parsed = parseProposals(
      '{"reply":42,"proposals":"nope","memory":[{"a":1},null,"valid"]}',
      has,
    );
    expect(parsed.parseError).toBe(false);
    expect(parsed.reply).toBe('');
    expect(parsed.proposals).toEqual([]);
    expect(parsed.memory).toEqual(['valid']);
  });

  it('parses delegate entries for known profile ids', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      proposals: [],
      memory: [],
      delegate: [{ to: 'p-writer', reason: 'kann besser texten' }],
    });
    const parsed = parseProposals(raw, has, ['p-writer', 'p-coder']);
    expect(parsed.delegate).toEqual([{ to: 'p-writer', reason: 'kann besser texten' }]);
  });

  it('filters delegate entries with unknown or malformed targets', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      proposals: [],
      memory: [],
      delegate: [
        { to: 'p-unknown', reason: 'x' },
        { to: 42 },
        'nope',
        { reason: 'missing to' },
        { to: 'p-coder' }, // reason optional → defaults to ''
      ],
    });
    const parsed = parseProposals(raw, has, ['p-writer', 'p-coder']);
    expect(parsed.delegate).toEqual([{ to: 'p-coder', reason: '' }]);
  });

  it('drops all delegates when no knownProfileIds are injected', () => {
    const raw = JSON.stringify({ reply: 'ok', delegate: [{ to: 'p-writer', reason: 'x' }] });
    expect(parseProposals(raw, has).delegate).toEqual([]);
  });

  it('parses forget lines and drops non-strings', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      forget: ['- [2026-01-01] veraltet', '', 42, null, 'mag Tee'],
    });
    const parsed = parseProposals(raw, has);
    expect(parsed.forget).toEqual(['- [2026-01-01] veraltet', 'mag Tee']);
  });
});

describe('executeProposals scope enforcement', () => {
  const proposals: AssistantProposal[] = [
    { command: 'todo.create', params: { title: 'a' }, summary: 's' },
    { command: 'calendar.addEvent', params: {}, summary: 's' },
    { command: 'system.wipeEverything', params: {}, summary: 'evil' },
  ];

  function fakeExecutor() {
    const calls: string[] = [];
    const execute = async (p: AssistantProposal): Promise<CommandResult> => {
      calls.push(p.command);
      return { ok: true };
    };
    return { calls, execute };
  }

  it('null scope executes everything', async () => {
    const { calls, execute } = fakeExecutor();
    const outcome = await executeProposals(proposals, { toolScope: null, execute });
    expect(outcome.executed).toHaveLength(3);
    expect(outcome.blocked).toHaveLength(0);
    expect(calls).toEqual(['todo.create', 'calendar.addEvent', 'system.wipeEverything']);
  });

  it('blocks out-of-scope commands BEFORE execution', async () => {
    const { calls, execute } = fakeExecutor();
    const outcome = await executeProposals(proposals, { toolScope: ['todo'], execute });
    expect(outcome.executed.map((e) => e.proposal.command)).toEqual(['todo.create']);
    expect(outcome.blocked.map((p) => p.command)).toEqual([
      'calendar.addEvent',
      'system.wipeEverything',
    ]);
    expect(calls).toEqual(['todo.create']); // blocked ones never reached the executor
  });

  it('accepts full command ids in the scope', async () => {
    const { execute } = fakeExecutor();
    const outcome = await executeProposals(proposals, {
      toolScope: ['calendar.addEvent'],
      execute,
    });
    expect(outcome.executed.map((e) => e.proposal.command)).toEqual(['calendar.addEvent']);
  });

  it('empty scope blocks everything', async () => {
    const { calls, execute } = fakeExecutor();
    const outcome = await executeProposals(proposals, { toolScope: [], execute });
    expect(outcome.executed).toHaveLength(0);
    expect(outcome.blocked).toHaveLength(3);
    expect(calls).toEqual([]);
  });
});

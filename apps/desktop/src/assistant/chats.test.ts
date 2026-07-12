import { describe, expect, it } from 'vitest';
import { createMemoryBackend } from '@cardo/core';
import {
  appendChat,
  CHAT_CONTEXT_CHAR_LIMIT,
  CHAT_CONTEXT_ENTRIES,
  CHAT_MAX_ENTRIES,
  chatContext,
  clearChat,
  estimateContextChars,
  loadChat,
  makeChatEntry,
  updateChatEntry,
  type ChatEntry,
} from './chats';

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return makeChatEntry({ role: 'user', text: 'hello', ...overrides });
}

describe('chat store', () => {
  it('append/load roundtrip keeps order and full entry shape', async () => {
    const backend = createMemoryBackend();
    const user = entry({ text: 'buy milk tomorrow' });
    const reply = makeChatEntry({
      role: 'assistant',
      speakerId: 'p-anna',
      text: 'On it!',
      proposals: [
        {
          command: 'todo.create',
          params: { title: 'buy milk' },
          summary: 'Creates the to-do "buy milk".',
          outcome: 'pending',
        },
      ],
      memory: ['shops on fridays'],
      memoryId: 'shared',
    });

    await appendChat('p-anna', user, backend);
    await appendChat('p-anna', reply, backend);

    const loaded = await loadChat('p-anna', backend);
    expect(loaded).toEqual([user, reply]);
    expect(loaded[1]?.proposals?.[0]?.outcome).toBe('pending');
  });

  it('loading an owner that never chatted yields []', async () => {
    const backend = createMemoryBackend();
    expect(await loadChat('nobody', backend)).toEqual([]);
  });

  it('drops malformed entries on load instead of crashing', async () => {
    const backend = createMemoryBackend();
    const good = entry({ text: 'kept' });
    await backend.set('core.assistant', 'chat:p1', {
      id: 'chat:p1',
      entries: [good, null, 42, { id: 'x' }, { ...entry(), role: 'evil' }],
    });
    expect(await loadChat('p1', backend)).toEqual([good]);
  });

  it(`caps at ${CHAT_MAX_ENTRIES} entries dropping the oldest`, async () => {
    const backend = createMemoryBackend();
    for (let i = 0; i < CHAT_MAX_ENTRIES + 5; i++) {
      await appendChat('p1', entry({ text: `msg ${i}` }), backend);
    }
    const loaded = await loadChat('p1', backend);
    expect(loaded).toHaveLength(CHAT_MAX_ENTRIES);
    expect(loaded[0]?.text).toBe('msg 5');
    expect(loaded[loaded.length - 1]?.text).toBe(`msg ${CHAT_MAX_ENTRIES + 4}`);
  });

  it('clearChat empties exactly the given owner', async () => {
    const backend = createMemoryBackend();
    await appendChat('p1', entry(), backend);
    await appendChat('p2', entry(), backend);
    await clearChat('p1', backend);
    expect(await loadChat('p1', backend)).toEqual([]);
    expect(await loadChat('p2', backend)).toHaveLength(1);
  });

  it('updateChatEntry patches a proposal outcome and never the id', async () => {
    const backend = createMemoryBackend();
    const reply = makeChatEntry({
      role: 'assistant',
      text: 'sure',
      proposals: [
        { command: 'todo.create', params: {}, summary: 's', outcome: 'pending' },
        { command: 'timer.start', params: {}, summary: 't', outcome: 'pending' },
      ],
    });
    await appendChat('p1', reply, backend);

    const proposals = reply.proposals!.map((p, i) => (i === 0 ? { ...p, outcome: 'done' as const } : p));
    await updateChatEntry('p1', reply.id, { proposals, id: 'hacked' } as Partial<ChatEntry>, backend);

    const loaded = await loadChat('p1', backend);
    expect(loaded[0]?.id).toBe(reply.id);
    expect(loaded[0]?.proposals?.[0]?.outcome).toBe('done');
    expect(loaded[0]?.proposals?.[1]?.outcome).toBe('pending');
  });

  it('updateChatEntry with an unknown id is a no-op', async () => {
    const backend = createMemoryBackend();
    const e = entry();
    await appendChat('p1', e, backend);
    await updateChatEntry('p1', 'missing', { text: 'changed' }, backend);
    expect(await loadChat('p1', backend)).toEqual([e]);
  });

  it('keeps chats per owner fully isolated', async () => {
    const backend = createMemoryBackend();
    await appendChat('p-anna', entry({ text: 'for anna' }), backend);
    await appendChat('t-team', entry({ text: 'for the team' }), backend);

    expect((await loadChat('p-anna', backend))[0]?.text).toBe('for anna');
    expect((await loadChat('t-team', backend))[0]?.text).toBe('for the team');

    await updateChatEntry('p-anna', (await loadChat('p-anna', backend))[0]!.id, { text: 'edited' }, backend);
    expect((await loadChat('t-team', backend))[0]?.text).toBe('for the team');
  });
});

describe('context window', () => {
  it('chatContext keeps only trailing user/assistant text entries', () => {
    const entries: ChatEntry[] = [
      entry({ text: 'oldest' }),
      makeChatEntry({ role: 'system', text: 'system line' }),
      makeChatEntry({ role: 'assistant', text: '' }),
      makeChatEntry({ role: 'assistant', text: 'a reply' }),
    ];
    for (let i = 0; i < CHAT_CONTEXT_ENTRIES; i++) entries.push(entry({ text: `u${i}` }));

    const ctx = chatContext(entries);
    expect(ctx).toHaveLength(CHAT_CONTEXT_ENTRIES);
    expect(ctx.every((e) => e.role !== 'system' && e.text !== '')).toBe(true);
    expect(ctx[0]?.text).toBe('u0');
  });

  it('estimateContextChars sums the text of the included entries only', () => {
    const entries: ChatEntry[] = [
      entry({ text: 'aa' }),
      makeChatEntry({ role: 'assistant', text: 'bbb' }),
      makeChatEntry({ role: 'system', text: 'ignored entirely' }),
    ];
    expect(estimateContextChars(entries)).toBe(5);
    expect(estimateContextChars(entries, 1)).toBe(3);
    expect(CHAT_CONTEXT_CHAR_LIMIT).toBeGreaterThan(0);
  });
});

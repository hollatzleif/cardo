// @vitest-environment jsdom
//
// Inbox feed on a dead network. Contract: refreshFeed/votePoll NEVER throw,
// the state flips to an honest error flag, a vote that could not reach the
// server is not recorded locally, and a later retry fully recovers.
// jsdom is needed because feed.ts arms window timers and the host backend
// checks for the Tauri marker on window.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getHost, initHost } from '../host';
import { getInboxState, getVoted, refreshFeed, votePoll, type FeedItem } from './feed';

beforeAll(() => {
  initHost(); // no Tauri marker on window → memory backend

  // jsdom 16 lacks the static AbortSignal.timeout used by fetchWithTimeout.
  // The polyfill mirrors the platform behavior and calls the *current*
  // setTimeout, so vi.useFakeTimers() controls it.
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FEED_ITEM: FeedItem = {
  id: 'ann-1',
  kind: 'announcement',
  open: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  payload: { title: { de: 'Hallo', en: 'Hello' }, body: { de: 'Welt', en: 'World' } },
};

describe('refreshFeed offline', () => {
  it('resolves (no throw) and sets the error flag when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(refreshFeed()).resolves.toBeUndefined();

    const state = getInboxState();
    expect(state.error).toBe(true);
    expect(state.loaded).toBe(true);
  });

  it('aborts via the fetch timeout when the connection hangs forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Never resolves – only the AbortSignal can end this request.
          const signal = init?.signal;
          const onAbort = () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = refreshFeed();
    // Nothing has failed yet; the hard 10s timeout must fire the abort.
    await vi.advanceTimersByTimeAsync(10_050);
    await expect(pending).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    expect(getInboxState().error).toBe(true);
  });
});

describe('votePoll offline', () => {
  it('returns false and leaves the voted store unchanged', async () => {
    // Seed a previous (successful) vote directly in the settings store.
    await getHost().backend.set('core.settings', 'polls.voted', {
      value: { 'poll-old': 'option-a' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(votePoll('poll-new', 'option-x')).resolves.toBe(false);

    expect(await getVoted()).toEqual({ 'poll-old': 'option-a' });
  });
});

describe('recovery after the network comes back', () => {
  it('a retry succeeds and clears the error flag', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, json: async () => ({ items: [FEED_ITEM] }) });
    vi.stubGlobal('fetch', fetchMock);

    await refreshFeed();
    expect(getInboxState().error).toBe(true);

    await refreshFeed();
    const state = getInboxState();
    expect(state.error).toBe(false);
    expect(state.loaded).toBe(true);
    expect(state.items).toEqual([FEED_ITEM]);
    expect(state.unread).toBe(1); // nothing marked seen yet
  });
});

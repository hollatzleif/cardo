// @vitest-environment jsdom
//
// Offline behavior of the weather tool: a dead network must never crash a
// command, never hard-fail, and never destroy the cached forecast. The tool
// is exercised exactly like the host does it – activate() with a test
// context, then commands through the registered-commands dispatch.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@cardo/plugin-api/testing';
import { createTool } from './index';
import type { DataDoc, PlaceDoc } from './weather';

beforeAll(() => {
  // jsdom 16 has AbortController but not the static AbortSignal.timeout the
  // tool's fetchWithTimeout uses – polyfill it so the real code path runs.
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
});

const PLACE: PlaceDoc = { name: 'Berlin', lat: 52.52, lon: 13.41 };

const CACHED: DataDoc = {
  fetchedAt: '2026-07-12T06:00:00.000Z',
  current: { temperature: 21.4, weatherCode: 2, windSpeed: 12.3, humidity: 58 },
  daily: [{ date: '2026-07-12', weatherCode: 2, tempMax: 24.1, tempMin: 14.2 }],
};

async function activatedTool() {
  const ctx = createTestContext();
  const tool = createTool();
  await tool.activate(ctx);
  return { ctx, tool };
}

describe('weather.refresh when the network is down', () => {
  it('resolves ok with an …offline message when fetch rejects (place configured)', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<PlaceDoc>('place', PLACE);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ctx.commands.execute('weather.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    // The real network path was attempted (not short-circuited elsewhere).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('api.open-meteo.com');
  });

  it('resolves ok with a …noPlace message and no network call without a place', async () => {
    const { ctx } = await activatedTool();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ctx.commands.execute('weather.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('noPlace')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the cached forecast untouched when a refresh fails', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<PlaceDoc>('place', PLACE);
    await ctx.storage.set<DataDoc>('data', CACHED);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await ctx.commands.execute('weather.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    // Honesty rule: never fake freshness, never nuke the cache.
    expect(await ctx.storage.get<DataDoc>('data')).toEqual(CACHED);
  });

  it('also reports offline (and keeps the cache) on an HTTP error response', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<PlaceDoc>('place', PLACE);
    await ctx.storage.set<DataDoc>('data', CACHED);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    const result = await ctx.commands.execute('weather.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    expect(await ctx.storage.get<DataDoc>('data')).toEqual(CACHED);
  });
});

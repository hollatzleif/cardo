// @vitest-environment jsdom
//
// Offline behavior of the currency tool (same pattern as the weather tool's
// offline suite): a dead network must never crash a command, never hard-fail
// and never destroy the cached rate table. Conversions are cache-only, so
// they must keep working with fetch rejecting outright.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@cardo/plugin-api/testing';
import { createTool } from './index';
import type { RatesDoc } from './logic';

beforeAll(() => {
  // jsdom lacks the static AbortSignal.timeout the tool's fetchWithTimeout
  // uses – polyfill it so the real code path runs.
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

const CACHED: RatesDoc = {
  type: 'rates',
  base: 'EUR',
  fetchedAtMs: Date.now() - 3 * 60 * 60 * 1000,
  rates: { EUR: 1, USD: 1.08, GBP: 0.85 },
};

async function activatedTool() {
  const ctx = createTestContext();
  const tool = createTool();
  await tool.activate(ctx);
  return { ctx, tool };
}

function deadFetch() {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('currency.refresh when the network is down', () => {
  it('resolves ok with an …offline message and keeps the cache untouched', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('currency.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    // The real network path was attempted with the declared host.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('open.er-api.com');
    // Honesty rule: never fake freshness, never nuke the cache.
    expect(await ctx.storage.get<RatesDoc>('rates:EUR')).toEqual(CACHED);
  });

  it('also reports offline (cache kept) on an HTTP error response', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    const result = await ctx.commands.execute('currency.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    expect(await ctx.storage.get<RatesDoc>('rates:EUR')).toEqual(CACHED);
  });

  it('rejects a garbage payload without poisoning the cache', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: 'error' }) }),
    );

    const result = await ctx.commands.execute('currency.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    expect(await ctx.storage.get<RatesDoc>('rates:EUR')).toEqual(CACHED);
  });
});

describe('currency.convert is cache-only', () => {
  it('converts from the seeded cache without a single network call', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('currency.convert', {
      amount: 100,
      from: 'USD',
      to: 'GBP',
    });

    expect(result.ok).toBe(true);
    const data = result.data as { result: number; text: string };
    expect(data.result).toBeCloseTo((100 / 1.08) * 0.85, 10);
    expect(fetchMock).not.toHaveBeenCalled();
    // The conversion is remembered for the assistant context.
    const last = await ctx.storage.get<{ from: string; to: string }>('last-pair');
    expect(last?.from).toBe('USD');
    expect(last?.to).toBe('GBP');
  });

  it('returns ok with a noRatesYet hint when there is no cache (diagnose stays green)', async () => {
    const { ctx } = await activatedTool();
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('currency.convert', {
      amount: 100,
      from: 'EUR',
      to: 'USD',
    });

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('noRatesYet')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails cleanly on unknown currency codes', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    deadFetch();

    const result = await ctx.commands.execute('currency.convert', {
      amount: 1,
      from: 'XXX',
      to: 'EUR',
    });

    expect(result.ok).toBe(false);
    expect(result.messageKey?.endsWith('unknownCode')).toBe(true);
  });
});

describe('assistant context', () => {
  it('describes the cached table and the last pair offline', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<RatesDoc>('rates:EUR', CACHED);
    deadFetch();
    await ctx.commands.execute('currency.convert', { amount: 100, from: 'EUR', to: 'USD' });

    const result = await ctx.commands.execute('currency.context', {});

    expect(result.ok).toBe(true);
    const text = (result.data as { contextText: string }).contextText;
    expect(text).toContain('EUR');
    expect(text).toContain('h ago');
    expect(text).toContain('Last conversion');
  });
});

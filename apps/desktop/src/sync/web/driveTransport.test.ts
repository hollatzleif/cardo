import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveTransport, NeedsGoogleAuth } from './driveTransport';

const auth = { token: async () => 'tok', invalidate: vi.fn() };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('web Drive transport', () => {
  it('retries a download that was aborted and lists the hub once per round', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const name = '0000000001000-aaaa.cardo-ops';
    let listCalls = 0;
    let downloads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('alt=media')) {
          downloads++;
          if (downloads === 1) throw new DOMException('Fetch is aborted', 'AbortError');
          return new Response('{"version":1,"ops":[{"op_id":"o1","blob_b64":"AAAA"}]}');
        }
        listCalls++;
        return json({ files: [{ id: 'f1', name }] });
      }),
    );
    const transport = new DriveTransport(auth);
    const pending = transport.pull('');
    await vi.runAllTimersAsync();
    const batch = await pending;
    expect(batch.ops.map((o) => o.opId)).toEqual(['o1']);
    expect(downloads).toBe(2);
    await transport.pull(batch.nextCursor);
    expect(listCalls).toBe(1);
  });

  it('asks for Google sign-in on 401 without retrying', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'expired' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DriveTransport(auth).pull('')).rejects.toBeInstanceOf(NeedsGoogleAuth);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.invalidate).toHaveBeenCalled();
  });
});

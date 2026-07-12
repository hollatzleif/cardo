/**
 * Cardo polls worker.
 *
 * Counts anonymous votes – nothing else. It does NOT know poll questions
 * (those live in apps/website/src/data/polls.json) and it stores NO personal
 * data: no IP, no user agent. One vote per (poll, device hash), enforced by
 * the primary key in D1.
 *
 * Endpoints (all JSON, CORS open):
 *   GET  /results?poll=<id> -> { poll, total, counts: { <optionId>: n } }
 *   GET  /results           -> { polls: { <pollId>: { total, counts } } }
 *   POST /vote { poll, option, device } -> 201 { ok: true }
 *                                        | 409 { ok: false, error: "already-voted" }
 */

interface Env {
  DB: D1Database;
}

// Minimal D1 typings so the worker stays dependency-free (no @cloudflare/workers-types).
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const MAX_BODY_BYTES = 1024; // basic abuse damping: reject oversized bodies
const DEVICE_HASH_RE = /^[0-9a-f]{64}$/; // sha-256, lowercase hex

interface VoteBody {
  poll: string;
  option: string;
  device: string;
}

function parseVoteBody(raw: unknown): VoteBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { poll, option, device } = raw as Record<string, unknown>;
  if (typeof poll !== 'string' || poll.length === 0 || poll.length > 64) return null;
  if (typeof option !== 'string' || option.length === 0 || option.length > 32) return null;
  if (typeof device !== 'string' || !DEVICE_HASH_RE.test(device)) return null;
  return { poll, option, device };
}

interface CountRow {
  poll_id: string;
  option_id: string;
  n: number;
}

type PollResult = { total: number; counts: Record<string, number> };

function tally(rows: CountRow[]): Record<string, PollResult> {
  const polls: Record<string, PollResult> = {};
  for (const row of rows) {
    const entry = (polls[row.poll_id] ??= { total: 0, counts: {} });
    entry.counts[row.option_id] = row.n;
    entry.total += row.n;
  }
  return polls;
}

async function handleResults(url: URL, env: Env): Promise<Response> {
  const pollId = url.searchParams.get('poll');
  if (pollId) {
    const { results } = await env.DB
      .prepare('SELECT poll_id, option_id, COUNT(*) AS n FROM votes WHERE poll_id = ? GROUP BY option_id')
      .bind(pollId)
      .all<CountRow>();
    const entry = tally(results)[pollId] ?? { total: 0, counts: {} };
    return json({ poll: pollId, total: entry.total, counts: entry.counts });
  }
  const { results } = await env.DB
    .prepare('SELECT poll_id, option_id, COUNT(*) AS n FROM votes GROUP BY poll_id, option_id')
    .all<CountRow>();
  return json({ polls: tally(results) });
}

async function handleVote(request: Request, env: Env): Promise<Response> {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader && Number(lengthHeader) > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'body-too-large' }, 413);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'body-too-large' }, 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'invalid-json' }, 400);
  }

  const vote = parseVoteBody(raw);
  if (!vote) {
    return json({ ok: false, error: 'invalid-vote' }, 400);
  }

  try {
    await env.DB
      .prepare('INSERT INTO votes (poll_id, device_hash, option_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(vote.poll, vote.device, vote.option, new Date().toISOString())
      .run();
  } catch (err) {
    // PRIMARY KEY (poll_id, device_hash) violation -> this installation already voted.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return json({ ok: false, error: 'already-voted' }, 409);
    }
    throw err;
  }
  return json({ ok: true }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/results') {
        return await handleResults(url, env);
      }
      if (request.method === 'POST' && url.pathname === '/vote') {
        return await handleVote(request, env);
      }
    } catch {
      return json({ ok: false, error: 'internal-error' }, 500);
    }
    return json({ ok: false, error: 'not-found' }, 404);
  },
};

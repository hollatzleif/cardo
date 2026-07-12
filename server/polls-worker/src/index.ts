/**
 * Cardo polls worker.
 *
 * Serves the public feed (polls + announcements) and counts anonymous votes.
 * Privacy first: it stores NO personal data – no IP, no user agent. One vote
 * per (poll, device hash), enforced by the primary key in D1.
 *
 * Public endpoints (all JSON, CORS open):
 *   GET  /feed              -> { items: [ { id, kind, open, createdAt, payload, results? } ] }
 *                              newest first, max 50; poll items include live results.
 *   GET  /results?poll=<id> -> { poll, total, counts: { <optionId>: n } }
 *   GET  /results           -> { polls: { <pollId>: { total, counts } } }
 *   POST /vote { poll, option, device } -> 201 { ok: true }
 *                                        | 404 poll/option unknown | 403 poll closed
 *                                        | 409 { ok: false, error: "already-voted" }
 *
 * Admin endpoints (Authorization: Bearer <session token>):
 *   POST   /admin/login { password }        -> { ok, token, expiresAt } (rate limited)
 *   POST   /admin/items { kind, payload, id? } -> 201 { ok, item }
 *   PATCH  /admin/items/:id { open }        -> { ok, id, open }
 *   DELETE /admin/items/:id                 -> { ok }
 *
 * Secrets (set via `npx wrangler secret put …`, never in code or logs):
 *   ADMIN_PASSWORD_HASH  "pbkdf2$<iterations>$<salt_b64>$<hash_b64>" (PBKDF2-SHA256)
 *   SESSION_SECRET       random string, HMAC key for session tokens
 */

interface Env {
  DB: D1Database;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
}

// Minimal D1 typings so the worker stays dependency-free (no @cloudflare/workers-types).
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const MAX_VOTE_BODY_BYTES = 1024; // basic abuse damping: reject oversized bodies
const MAX_ADMIN_BODY_BYTES = 8192;
const DEVICE_HASH_RE = /^[0-9a-f]{64}$/; // sha-256, lowercase hex
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown } | { error: Response }> {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    return { error: json({ ok: false, error: 'body-too-large' }, 413) };
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    return { error: json({ ok: false, error: 'body-too-large' }, 413) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: json({ ok: false, error: 'invalid-json' }, 400) };
  }
}

function b64Decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return b64Decode(padded);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Auth: PBKDF2 password verification + HMAC session tokens            */
/* ------------------------------------------------------------------ */

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Format: "pbkdf2$<iterations>$<salt_b64>$<hash_b64>", PBKDF2-HMAC-SHA256.
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = b64Decode(parts[2]);
  const expected = b64Decode(parts[3]);
  if (!salt || !expected || expected.length === 0) return false;

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    expected.length * 8,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function createToken(secret: string): Promise<{ token: string; expiresAt: string }> {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = encoder.encode(JSON.stringify({ exp }));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return {
    token: `${b64urlEncode(payload)}.${b64urlEncode(sig)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payloadBytes = b64urlDecode(token.slice(0, dot));
  const sigBytes = b64urlDecode(token.slice(dot + 1));
  if (!payloadBytes || !sigBytes) return false;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
  if (!valid) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  if (typeof payload !== 'object' || payload === null) return false;
  const exp = (payload as Record<string, unknown>).exp;
  return typeof exp === 'number' && exp > Date.now();
}

/** Returns a 401/500 response if the request is not an authenticated admin, else null. */
async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!env.SESSION_SECRET) return json({ ok: false, error: 'not-configured' }, 500);
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await verifyToken(token, env.SESSION_SECRET))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Item payload validation                                             */
/* ------------------------------------------------------------------ */

interface Localized {
  en: string;
  de: string;
}
interface PollOption {
  id: string;
  label: Localized;
}
interface PollPayload {
  question: Localized;
  options: PollOption[];
}
interface AnnouncementPayload {
  title: Localized;
  body: Localized;
}

function parseLocalized(raw: unknown, maxLen: number): Localized | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { en, de } = raw as Record<string, unknown>;
  if (typeof en !== 'string' || en.trim().length === 0 || en.length > maxLen) return null;
  if (typeof de !== 'string' || de.trim().length === 0 || de.length > maxLen) return null;
  return { en, de };
}

function parsePollPayload(raw: unknown): PollPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { question, options } = raw as Record<string, unknown>;
  const parsedQuestion = parseLocalized(question, 500);
  if (!parsedQuestion) return null;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) return null;
  const seen = new Set<string>();
  const parsedOptions: PollOption[] = [];
  for (const option of options) {
    if (typeof option !== 'object' || option === null) return null;
    const { id, label } = option as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 32 || !KEBAB_RE.test(id) || seen.has(id)) return null;
    const parsedLabel = parseLocalized(label, 200);
    if (!parsedLabel) return null;
    seen.add(id);
    parsedOptions.push({ id, label: parsedLabel });
  }
  return { question: parsedQuestion, options: parsedOptions };
}

function parseAnnouncementPayload(raw: unknown): AnnouncementPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { title, body } = raw as Record<string, unknown>;
  const parsedTitle = parseLocalized(title, 500);
  const parsedBody = parseLocalized(body, 4000);
  if (!parsedTitle || !parsedBody) return null;
  return { title: parsedTitle, body: parsedBody };
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'item';
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/* ------------------------------------------------------------------ */
/* Public: results + vote                                              */
/* ------------------------------------------------------------------ */

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

async function handleVote(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, MAX_VOTE_BODY_BYTES);
  if ('error' in body) return body.error;

  const vote = parseVoteBody(body.value);
  if (!vote) {
    return json({ ok: false, error: 'invalid-vote' }, 400);
  }

  // The poll must exist as an open item and the option must belong to it.
  const { results: pollRows } = await env.DB
    .prepare("SELECT payload, open FROM items WHERE id = ? AND kind = 'poll'")
    .bind(vote.poll)
    .all<{ payload: string; open: number }>();
  const pollRow = pollRows[0];
  if (!pollRow) return json({ ok: false, error: 'poll-not-found' }, 404);
  if (pollRow.open !== 1) return json({ ok: false, error: 'poll-closed' }, 403);

  let pollPayload: PollPayload | null = null;
  try {
    pollPayload = JSON.parse(pollRow.payload) as PollPayload;
  } catch {
    pollPayload = null;
  }
  const options = pollPayload && Array.isArray(pollPayload.options) ? pollPayload.options : [];
  const optionExists = options.some((option) => option && option.id === vote.option);
  if (!optionExists) return json({ ok: false, error: 'option-not-found' }, 404);

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

/* ------------------------------------------------------------------ */
/* Public: feed                                                        */
/* ------------------------------------------------------------------ */

interface ItemRow {
  id: string;
  kind: string;
  payload: string;
  open: number;
  created_at: string;
}

async function handleFeed(env: Env): Promise<Response> {
  const { results: rows } = await env.DB
    .prepare('SELECT id, kind, payload, open, created_at FROM items ORDER BY created_at DESC, id LIMIT 50')
    .all<ItemRow>();

  let pollResults: Record<string, PollResult> = {};
  if (rows.some((row) => row.kind === 'poll')) {
    const { results } = await env.DB
      .prepare('SELECT poll_id, option_id, COUNT(*) AS n FROM votes GROUP BY poll_id, option_id')
      .all<CountRow>();
    pollResults = tally(results);
  }

  const items = rows.map((row) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    const item: Record<string, unknown> = {
      id: row.id,
      kind: row.kind,
      open: row.open === 1,
      createdAt: row.created_at,
      payload,
    };
    if (row.kind === 'poll') {
      item.results = pollResults[row.id] ?? { total: 0, counts: {} };
    }
    return item;
  });
  return json({ items });
}

/* ------------------------------------------------------------------ */
/* Admin handlers                                                      */
/* ------------------------------------------------------------------ */

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
    return json({ ok: false, error: 'not-configured' }, 500);
  }

  // Rate limit: max LOGIN_MAX_ATTEMPTS per fixed window, tracked without any
  // client identifier (no IP!) – one global counter per window.
  const windowStart = new Date(Math.floor(Date.now() / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS).toISOString();
  await env.DB.prepare('DELETE FROM login_attempts WHERE window_start <> ?').bind(windowStart).run();
  await env.DB
    .prepare(
      'INSERT INTO login_attempts (window_start, count) VALUES (?, 1) ON CONFLICT(window_start) DO UPDATE SET count = count + 1',
    )
    .bind(windowStart)
    .run();
  const { results: attemptRows } = await env.DB
    .prepare('SELECT count FROM login_attempts WHERE window_start = ?')
    .bind(windowStart)
    .all<{ count: number }>();
  if ((attemptRows[0]?.count ?? 0) > LOGIN_MAX_ATTEMPTS) {
    return json({ ok: false, error: 'too-many-attempts' }, 429);
  }

  const body = await readJsonBody(request, MAX_ADMIN_BODY_BYTES);
  if ('error' in body) return body.error;
  if (typeof body.value !== 'object' || body.value === null) {
    return json({ ok: false, error: 'invalid-body' }, 400);
  }
  const { password } = body.value as Record<string, unknown>;
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    return json({ ok: false, error: 'invalid-body' }, 400);
  }

  if (!(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
    return json({ ok: false, error: 'invalid-password' }, 401);
  }

  const session = await createToken(env.SESSION_SECRET);
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt });
}

async function handleCreateItem(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, MAX_ADMIN_BODY_BYTES);
  if ('error' in body) return body.error;
  if (typeof body.value !== 'object' || body.value === null) {
    return json({ ok: false, error: 'invalid-body' }, 400);
  }
  const { kind, payload, id } = body.value as Record<string, unknown>;

  let parsedPayload: PollPayload | AnnouncementPayload | null = null;
  if (kind === 'poll') parsedPayload = parsePollPayload(payload);
  else if (kind === 'announcement') parsedPayload = parseAnnouncementPayload(payload);
  else return json({ ok: false, error: 'invalid-kind' }, 400);
  if (!parsedPayload) return json({ ok: false, error: 'invalid-payload' }, 400);

  let explicitId: string | null = null;
  if (id !== undefined) {
    if (typeof id !== 'string' || id.length > 64 || !KEBAB_RE.test(id)) {
      return json({ ok: false, error: 'invalid-id' }, 400);
    }
    explicitId = id;
  }

  const titleText =
    kind === 'poll'
      ? (parsedPayload as PollPayload).question.en
      : (parsedPayload as AnnouncementPayload).title.en;
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(parsedPayload);

  for (let attempt = 0; attempt < 3; attempt++) {
    const itemId = explicitId ?? `${slugify(titleText)}-${randomSuffix()}`;
    try {
      await env.DB
        .prepare('INSERT INTO items (id, kind, payload, open, created_at) VALUES (?, ?, ?, 1, ?)')
        .bind(itemId, kind, payloadJson, createdAt)
        .run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        if (explicitId) return json({ ok: false, error: 'id-exists' }, 409);
        continue; // generated id collided – retry with a fresh suffix
      }
      throw err;
    }
    return json(
      { ok: true, item: { id: itemId, kind, open: true, createdAt, payload: parsedPayload } },
      201,
    );
  }
  return json({ ok: false, error: 'id-collision' }, 500);
}

async function handlePatchItem(request: Request, env: Env, itemId: string): Promise<Response> {
  const body = await readJsonBody(request, MAX_ADMIN_BODY_BYTES);
  if ('error' in body) return body.error;
  if (typeof body.value !== 'object' || body.value === null) {
    return json({ ok: false, error: 'invalid-body' }, 400);
  }
  const { open } = body.value as Record<string, unknown>;
  if (typeof open !== 'boolean') {
    return json({ ok: false, error: 'invalid-body' }, 400);
  }
  const result = await env.DB
    .prepare('UPDATE items SET open = ? WHERE id = ?')
    .bind(open ? 1 : 0, itemId)
    .run();
  if (!result.meta?.changes) return json({ ok: false, error: 'not-found' }, 404);
  return json({ ok: true, id: itemId, open });
}

async function handleDeleteItem(env: Env, itemId: string): Promise<Response> {
  // Votes referencing the item stay in the votes table – they are anonymous
  // counters without meaning once the poll is gone, and deleting them is not
  // required for privacy (they never contained personal data).
  const result = await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(itemId).run();
  if (!result.meta?.changes) return json({ ok: false, error: 'not-found' }, 404);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const ADMIN_ITEM_RE = /^\/admin\/items\/([a-z0-9-]{1,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/feed') {
        return await handleFeed(env);
      }
      if (request.method === 'GET' && url.pathname === '/results') {
        return await handleResults(url, env);
      }
      if (request.method === 'POST' && url.pathname === '/vote') {
        return await handleVote(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/admin/login') {
        return await handleLogin(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/admin/items') {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return await handleCreateItem(request, env);
      }
      const itemMatch = url.pathname.match(ADMIN_ITEM_RE);
      if (itemMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return request.method === 'PATCH'
          ? await handlePatchItem(request, env, itemMatch[1])
          : await handleDeleteItem(env, itemMatch[1]);
      }
    } catch {
      return json({ ok: false, error: 'internal-error' }, 500);
    }
    return json({ ok: false, error: 'not-found' }, 404);
  },
};

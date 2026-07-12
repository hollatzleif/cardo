// Adversarial security suite for the Cardo polls worker.
// Zero dependencies: node:test + node:crypto only. Run with:
//   node --test server/polls-worker/test/
//
// The worker is imported as a plain ES module (Node strips the TS types)
// and driven directly via `worker.fetch(new Request(...), env)`, with a
// fake D1 that enforces the real UNIQUE constraints.

/* global Request */
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.ts';
import { FakeD1, makePasswordHash, makeSessionToken, b64url } from './fake-d1.mjs';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PASSWORD = 'correct horse battery staple 42!';
const SECRET = 'test-secret';
// Generated once at load: real PBKDF2-SHA256, 100k iterations, worker format.
const ADMIN_PASSWORD_HASH = makePasswordHash(PASSWORD, 100000);

function makeEnv() {
  return { DB: new FakeD1(), ADMIN_PASSWORD_HASH, SESSION_SECRET: SECRET };
}

const BASE = 'https://worker.test';

function req(method, path, { body, headers } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  return new Request(BASE + path, init);
}

async function call(env, method, path, opts) {
  return worker.fetch(req(method, path, opts), env);
}

async function bodyOf(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

const VALID_POLL = {
  question: { en: 'Ready?', de: 'Bereit?' },
  options: [
    { id: 'yes', label: { en: 'Yes', de: 'Ja' } },
    { id: 'no', label: { en: 'No', de: 'Nein' } },
  ],
};

const VALID_ANNOUNCEMENT = {
  title: { en: 'Hello', de: 'Hallo' },
  body: { en: 'Body text', de: 'Textkörper' },
};

const HEX64 = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

async function getToken(env) {
  const res = await call(env, 'POST', '/admin/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const { json } = await bodyOf(res);
  assert.ok(json.token, 'login should return a token');
  return json.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createItem(env, token, payload) {
  return call(env, 'POST', '/admin/items', { headers: auth(token), body: payload });
}

/* ------------------------------------------------------------------ */
/* 1. Login                                                            */
/* ------------------------------------------------------------------ */

test('login: correct password returns 200 + token + expiry', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/admin/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const { json } = await bodyOf(res);
  assert.equal(json.ok, true);
  assert.equal(typeof json.token, 'string');
  assert.ok(json.token.includes('.'), 'token is payload.sig');
  assert.ok(Date.parse(json.expiresAt) > Date.now(), 'expiresAt in the future');
});

test('login: wrong password returns 401', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/admin/login', { body: { password: 'nope' } });
  assert.equal(res.status, 401);
  const { json } = await bodyOf(res);
  assert.equal(json.ok, false);
  assert.equal(json.token, undefined);
});

test('login: empty password returns 400', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/admin/login', { body: { password: '' } });
  assert.equal(res.status, 400);
});

test('login: missing password field returns 400', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/admin/login', { body: {} });
  assert.equal(res.status, 400);
});

test('login: non-string password returns 400', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/admin/login', { body: { password: 12345 } });
  assert.equal(res.status, 400);
});

test('login: not-configured env returns 500', async () => {
  const env = { DB: new FakeD1() }; // no hash / secret
  const res = await call(env, 'POST', '/admin/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 500);
});

test('login: more than 10 attempts in the window returns 429', async () => {
  const env = makeEnv();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await call(env, 'POST', '/admin/login', { body: { password: 'wrong' } });
    statuses.push(res.status);
  }
  // First 10 are processed (401 wrong password), the 11th trips the limit.
  assert.equal(statuses[9], 401, 'attempt 10 still processed');
  assert.equal(statuses[10], 429, 'attempt 11 rate-limited');
  assert.equal(statuses[11], 429, 'attempt 12 rate-limited');
});

test('login: rate limit blocks even the correct password once tripped', async () => {
  const env = makeEnv();
  for (let i = 0; i < 11; i++) {
    await call(env, 'POST', '/admin/login', { body: { password: 'wrong' } });
  }
  const res = await call(env, 'POST', '/admin/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 429);
});

test('login: password is NEVER echoed in any response body', async () => {
  const env = makeEnv();
  for (const pw of [PASSWORD, 'wrong-secret-guess-123456']) {
    const res = await call(env, 'POST', '/admin/login', { body: { password: pw } });
    const { text } = await bodyOf(res);
    assert.ok(!text.includes(pw), `response leaked password ${pw}`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Session tokens                                                   */
/* ------------------------------------------------------------------ */

test('session: valid token authorises admin ops', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const res = await createItem(env, token, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 201);
});

test('session: tampered payload (valid sig of a different payload) is rejected', async () => {
  const env = makeEnv();
  const good = makeSessionToken(SECRET, Date.now() + 3600_000);
  const sig = good.split('.')[1];
  // Re-encode a different payload but keep the old signature.
  const forgedPayload = b64url(Buffer.from(JSON.stringify({ exp: Date.now() + 9999999 })));
  const forged = `${forgedPayload}.${sig}`;
  const res = await createItem(env, forged, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 401);
});

test('session: tampered signature is rejected', async () => {
  const env = makeEnv();
  const good = makeSessionToken(SECRET, Date.now() + 3600_000);
  const [payload, sig] = good.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const res = await createItem(env, `${payload}.${flipped}`, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 401);
});

test('session: correctly signed but expired token is rejected', async () => {
  const env = makeEnv();
  const expired = makeSessionToken(SECRET, Date.now() - 1000);
  const res = await createItem(env, expired, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 401);
});

test('session: token signed with the wrong secret is rejected', async () => {
  const env = makeEnv();
  const wrong = makeSessionToken('not-the-secret', Date.now() + 3600_000);
  const res = await createItem(env, wrong, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 401);
});

test('session: missing / garbage Authorization headers are rejected', async () => {
  const env = makeEnv();
  const cases = [
    undefined,
    { Authorization: '' },
    { Authorization: 'Bearer' },
    { Authorization: 'Bearer ' },
    { Authorization: 'Bearer not-a-token' },
    { Authorization: 'Bearer a.b' },
    { Authorization: 'Basic dXNlcjpwYXNz' },
    { Authorization: 'garbage' },
  ];
  for (const headers of cases) {
    const res = await call(env, 'POST', '/admin/items', {
      headers: { ...(headers ?? {}) },
      body: { kind: 'poll', payload: VALID_POLL },
    });
    assert.equal(res.status, 401, `expected 401 for headers=${JSON.stringify(headers)}`);
  }
});

test('session: admin route with SESSION_SECRET unset returns 500', async () => {
  const env = { DB: new FakeD1(), ADMIN_PASSWORD_HASH };
  const res = await createItem(env, 'anything', { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 500);
});

/* ------------------------------------------------------------------ */
/* 3. Items                                                            */
/* ------------------------------------------------------------------ */

test('items: valid poll is created (201) and echoed', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const res = await createItem(env, token, { kind: 'poll', payload: VALID_POLL });
  assert.equal(res.status, 201);
  const { json } = await bodyOf(res);
  assert.equal(json.ok, true);
  assert.equal(json.item.kind, 'poll');
  assert.match(json.item.id, /^[a-z0-9-]+$/);
});

test('items: poll with only 1 option is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const payload = { question: VALID_POLL.question, options: [VALID_POLL.options[0]] };
  const res = await createItem(env, token, { kind: 'poll', payload });
  assert.equal(res.status, 400);
});

test('items: poll with 7 options is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const options = Array.from({ length: 7 }, (_, i) => ({
    id: `opt-${i}`,
    label: { en: `O${i}`, de: `O${i}` },
  }));
  const res = await createItem(env, token, { kind: 'poll', payload: { question: VALID_POLL.question, options } });
  assert.equal(res.status, 400);
});

test('items: poll missing a language on the question is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const payload = { question: { en: 'Only EN' }, options: VALID_POLL.options };
  const res = await createItem(env, token, { kind: 'poll', payload });
  assert.equal(res.status, 400);
});

test('items: poll with a non-kebab option id is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  for (const badId of ['Option_1', 'opt 1', 'UPPER', 'a--b', '-lead', 'trail-']) {
    const payload = {
      question: VALID_POLL.question,
      options: [
        { id: badId, label: { en: 'A', de: 'A' } },
        { id: 'ok', label: { en: 'B', de: 'B' } },
      ],
    };
    const res = await createItem(env, token, { kind: 'poll', payload });
    assert.equal(res.status, 400, `should reject option id ${badId}`);
  }
});

test('items: poll with duplicate option ids is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const payload = {
    question: VALID_POLL.question,
    options: [
      { id: 'same', label: { en: 'A', de: 'A' } },
      { id: 'same', label: { en: 'B', de: 'B' } },
    ],
  };
  const res = await createItem(env, token, { kind: 'poll', payload });
  assert.equal(res.status, 400);
});

test('items: announcement requires both languages in body', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const payload = { title: VALID_ANNOUNCEMENT.title, body: { en: 'only en' } };
  const res = await createItem(env, token, { kind: 'announcement', payload });
  assert.equal(res.status, 400);
});

test('items: valid announcement is created (201)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const res = await createItem(env, token, { kind: 'announcement', payload: VALID_ANNOUNCEMENT });
  assert.equal(res.status, 201);
});

test('items: unknown kind is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const res = await createItem(env, token, { kind: 'malware', payload: {} });
  assert.equal(res.status, 400);
});

test('items: explicit id collision returns 409', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const first = await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'my-poll' });
  assert.equal(first.status, 201);
  const second = await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'my-poll' });
  assert.equal(second.status, 409);
});

test('items: invalid explicit id is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  for (const badId of ['Not Kebab', 'has_underscore', '../escape', 'UPPER']) {
    const res = await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: badId });
    assert.equal(res.status, 400, `should reject id ${badId}`);
  }
});

test('items: PATCH open toggle flips the flag and blocks/allows voting', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'toggle-poll' });

  const close = await call(env, 'PATCH', '/admin/items/toggle-poll', {
    headers: auth(token),
    body: { open: false },
  });
  assert.equal(close.status, 200);
  const closedVote = await call(env, 'POST', '/vote', {
    body: { poll: 'toggle-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(closedVote.status, 403);

  const open = await call(env, 'PATCH', '/admin/items/toggle-poll', {
    headers: auth(token),
    body: { open: true },
  });
  assert.equal(open.status, 200);
  const okVote = await call(env, 'POST', '/vote', {
    body: { poll: 'toggle-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(okVote.status, 201);
});

test('items: PATCH with non-boolean open is rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'p1' });
  const res = await call(env, 'PATCH', '/admin/items/p1', { headers: auth(token), body: { open: 'yes' } });
  assert.equal(res.status, 400);
});

test('items: PATCH on unknown id returns 404', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const res = await call(env, 'PATCH', '/admin/items/ghost', { headers: auth(token), body: { open: false } });
  assert.equal(res.status, 404);
});

test('items: DELETE removes the item and is 404 the second time', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'gone-soon' });
  const del = await call(env, 'DELETE', '/admin/items/gone-soon', { headers: auth(token) });
  assert.equal(del.status, 200);
  const again = await call(env, 'DELETE', '/admin/items/gone-soon', { headers: auth(token) });
  assert.equal(again.status, 404);
  // Feed no longer contains it.
  const feed = await call(env, 'GET', '/feed');
  const { json } = await bodyOf(feed);
  assert.ok(!json.items.some((i) => i.id === 'gone-soon'));
});

/* ------------------------------------------------------------------ */
/* 4. Vote                                                             */
/* ------------------------------------------------------------------ */

test('vote: unknown poll returns 404', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/vote', {
    body: { poll: 'does-not-exist', option: 'yes', device: HEX64 },
  });
  assert.equal(res.status, 404);
});

test('vote: closed poll returns 403', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'closed-poll' });
  await call(env, 'PATCH', '/admin/items/closed-poll', { headers: auth(token), body: { open: false } });
  const res = await call(env, 'POST', '/vote', {
    body: { poll: 'closed-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(res.status, 403);
});

test('vote: unknown option on an open poll returns 404', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'open-poll' });
  const res = await call(env, 'POST', '/vote', {
    body: { poll: 'open-poll', option: 'maybe', device: HEX64 },
  });
  assert.equal(res.status, 404);
  const { json } = await bodyOf(res);
  assert.equal(json.error, 'option-not-found');
});

test('vote: valid vote returns 201 and increments the count', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'live-poll' });
  const res = await call(env, 'POST', '/vote', {
    body: { poll: 'live-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(res.status, 201);
  const results = await call(env, 'GET', '/results?poll=live-poll');
  const { json } = await bodyOf(results);
  assert.equal(json.total, 1);
  assert.equal(json.counts.yes, 1);
});

test('vote: bad device hashes are rejected (400)', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'dev-poll' });
  const badDevices = [
    'a'.repeat(63), // too short
    'a'.repeat(65), // too long
    'A'.repeat(64), // uppercase hex not allowed
    'g'.repeat(64), // non-hex letter
    'z'.repeat(64),
    '',
    HEX64.slice(0, 60) + '   ' + 'a', // spaces
  ];
  for (const device of badDevices) {
    const res = await call(env, 'POST', '/vote', {
      body: { poll: 'dev-poll', option: 'yes', device },
    });
    assert.equal(res.status, 400, `should reject device ${JSON.stringify(device)}`);
  }
});

test('vote: duplicate vote from the same device returns 409, count unchanged', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'dup-poll' });
  const first = await call(env, 'POST', '/vote', {
    body: { poll: 'dup-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(first.status, 201);
  const second = await call(env, 'POST', '/vote', {
    body: { poll: 'dup-poll', option: 'no', device: HEX64 },
  });
  assert.equal(second.status, 409);
  const { json } = await bodyOf(second);
  assert.equal(json.error, 'already-voted');
  const results = await call(env, 'GET', '/results?poll=dup-poll');
  const { json: r } = await bodyOf(results);
  assert.equal(r.total, 1, 'duplicate must not change the count');
  assert.equal(r.counts.no, undefined, 'second option not counted');
});

test('vote: different devices each count once', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'multi-poll' });
  await call(env, 'POST', '/vote', { body: { poll: 'multi-poll', option: 'yes', device: HEX64 } });
  await call(env, 'POST', '/vote', { body: { poll: 'multi-poll', option: 'no', device: HEX64_B } });
  const results = await call(env, 'GET', '/results?poll=multi-poll');
  const { json } = await bodyOf(results);
  assert.equal(json.total, 2);
  assert.equal(json.counts.yes, 1);
  assert.equal(json.counts.no, 1);
});

test('vote: SQL-injection strings are handled cleanly and the DB keeps working', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'inj-poll' });

  const inj = "'; DROP TABLE votes;--";

  // Injection in the poll field -> poll not found, clean 404.
  const r1 = await call(env, 'POST', '/vote', { body: { poll: inj, option: 'yes', device: HEX64 } });
  assert.ok(r1.status >= 400 && r1.status < 500, 'clean 4xx for poll injection');

  // Injection in the option field of a real poll -> option not found, 404.
  const r2 = await call(env, 'POST', '/vote', { body: { poll: 'inj-poll', option: inj, device: HEX64 } });
  assert.equal(r2.status, 404);

  // Injection in the device field -> fails the hex regex, 400.
  const r3 = await call(env, 'POST', '/vote', { body: { poll: 'inj-poll', option: 'yes', device: inj } });
  assert.equal(r3.status, 400);

  // The votes table still works afterwards.
  const good = await call(env, 'POST', '/vote', {
    body: { poll: 'inj-poll', option: 'yes', device: HEX64 },
  });
  assert.equal(good.status, 201);
  const results = await call(env, 'GET', '/results?poll=inj-poll');
  const { json } = await bodyOf(results);
  assert.equal(json.total, 1);
});

test('vote: malformed JSON body returns 400', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/vote', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ */
/* 5. Body-size limits                                                 */
/* ------------------------------------------------------------------ */

test('limits: /vote body larger than 1KB returns 413', async () => {
  const env = makeEnv();
  const bigDevice = 'a'.repeat(2000);
  const body = JSON.stringify({ poll: 'x', option: 'y', device: bigDevice });
  assert.ok(body.length > 1024);
  const res = await call(env, 'POST', '/vote', { body });
  assert.equal(res.status, 413);
});

test('limits: admin body larger than 8KB returns 413', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  const padding = 'x'.repeat(9000);
  const body = JSON.stringify({ kind: 'poll', payload: VALID_POLL, pad: padding });
  assert.ok(body.length > 8192);
  const res = await call(env, 'POST', '/admin/items', { headers: auth(token), body });
  assert.equal(res.status, 413);
});

test('limits: oversized Content-Length header is rejected up front (413)', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/vote', {
    body: JSON.stringify({ poll: 'x', option: 'y', device: HEX64 }),
    headers: { 'Content-Length': '99999' },
  });
  assert.equal(res.status, 413);
});

/* ------------------------------------------------------------------ */
/* 6. Headers / CORS                                                   */
/* ------------------------------------------------------------------ */

test('headers: every response carries CORS + nosniff', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'hdr-poll' });
  const responses = [
    await call(env, 'GET', '/feed'),
    await call(env, 'GET', '/results'),
    await call(env, 'POST', '/vote', { body: { poll: 'hdr-poll', option: 'yes', device: HEX64 } }),
    await call(env, 'POST', '/admin/login', { body: { password: 'wrong' } }),
    await call(env, 'GET', '/nonexistent'),
  ];
  for (const res of responses) {
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
});

test('headers: OPTIONS preflight returns 204 with CORS headers', async () => {
  const env = makeEnv();
  const res = await call(env, 'OPTIONS', '/vote');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(res.headers.get('Access-Control-Allow-Methods').includes('POST'));
});

test('headers: unknown route returns 404 JSON', async () => {
  const env = makeEnv();
  const res = await call(env, 'GET', '/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
});

/* ------------------------------------------------------------------ */
/* 7. Feed + no-secret-leak                                            */
/* ------------------------------------------------------------------ */

test('feed: returns items with poll results merged in', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'feed-poll' });
  await createItem(env, token, { kind: 'announcement', payload: VALID_ANNOUNCEMENT, id: 'feed-ann' });
  await call(env, 'POST', '/vote', { body: { poll: 'feed-poll', option: 'yes', device: HEX64 } });

  const res = await call(env, 'GET', '/feed');
  assert.equal(res.status, 200);
  const { json } = await bodyOf(res);
  const poll = json.items.find((i) => i.id === 'feed-poll');
  const ann = json.items.find((i) => i.id === 'feed-ann');
  assert.ok(poll, 'poll present in feed');
  assert.ok(ann, 'announcement present in feed');
  assert.equal(poll.results.total, 1);
  assert.equal(poll.results.counts.yes, 1);
  assert.equal(ann.results, undefined, 'announcements carry no results');
});

test('feed/responses: never leak SESSION_SECRET or the password hash', async () => {
  const env = makeEnv();
  const token = await getToken(env);
  await createItem(env, token, { kind: 'poll', payload: VALID_POLL, id: 'scan-poll' });
  await call(env, 'POST', '/vote', { body: { poll: 'scan-poll', option: 'yes', device: HEX64 } });

  const hashParts = ADMIN_PASSWORD_HASH.split('$');
  const needles = [SECRET, ADMIN_PASSWORD_HASH, hashParts[2], hashParts[3], PASSWORD];

  const bodies = [];
  for (const [method, path, opts] of [
    ['GET', '/feed'],
    ['GET', '/results'],
    ['GET', '/results?poll=scan-poll'],
    ['POST', '/admin/login', { body: { password: PASSWORD } }],
    ['POST', '/admin/login', { body: { password: 'wrong' } }],
    ['GET', '/missing'],
  ]) {
    const res = await call(env, method, path, opts);
    bodies.push((await bodyOf(res)).text);
  }

  for (const text of bodies) {
    for (const needle of needles) {
      assert.ok(!text.includes(needle), `response leaked a secret value: ${needle.slice(0, 12)}...`);
    }
  }
});

test('feed: empty database returns an empty item list', async () => {
  const env = makeEnv();
  const res = await call(env, 'GET', '/feed');
  const { json } = await bodyOf(res);
  assert.deepEqual(json.items, []);
});

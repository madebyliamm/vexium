// auth-gate unit tests — run:  node --test supabase/tests/auth_gate.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, legacyEmailFor, type GateDeps } from '../functions/auth-gate/handler.ts';

const SECRET_EMAIL = 'real.person@private-mail.example';

function world(over: Partial<GateDeps> = {}) {
  const counters = new Map<string, number>();
  const calls = { signIn: [] as { email: string; password: string; ip: string }[], emailOfUser: 0, userIdByUsername: [] as string[] };
  const deps: GateDeps = {
    async rateHit(key, win, limit, cost) {
      const hits = (counters.get(key) ?? 0) + cost;
      counters.set(key, hits);
      return { allowed: cost > 0 ? hits <= limit : hits < limit, retry_after: 42 };
    },
    async userIdByUsername(u) { calls.userIdByUsername.push(u); return u.toLowerCase() === 'liam' ? 'uid-1' : null; },
    async emailOfUser(id) { calls.emailOfUser++; return id === 'uid-1' ? SECRET_EMAIL : null; },
    async signIn(email, password, ip) {
      calls.signIn.push({ email, password, ip });
      if (email === SECRET_EMAIL && password === 'right-pass') return { ok: true, session: { access_token: 'AT', refresh_token: 'RT', user: { id: 'uid-1' } } };
      if (email === 'unconfirmed@x.co' && password === 'right-pass') return { ok: false, code: 'email_not_confirmed' };
      return { ok: false, code: 'invalid_credentials' };
    },
    async availability(u, e) { return { username_taken: u.toLowerCase() === 'liam', email_taken: e === SECRET_EMAIL }; },
    ...over,
  };
  return { deps, calls };
}

const post = (w: ReturnType<typeof world>, body: unknown, ip = '203.0.113.7') =>
  handle(new Request('https://x/auth-gate', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': ip } }), w.deps);
const login = (w: ReturnType<typeof world>, identifier: string, password: string, ip?: string) => post(w, { action: 'login', identifier, password }, ip);

describe('auth-gate login', () => {
  it('username + right password → session; the real email never appears in the response', async () => {
    const w = world();
    const res = await login(w, 'Liam', 'right-pass');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SECRET_EMAIL));
    assert.equal(JSON.parse(text).session.access_token, 'AT');
    assert.deepEqual(w.calls.signIn[0], { email: SECRET_EMAIL, password: 'right-pass', ip: '203.0.113.7' });
  });
  it('email + right password works too (no username lookup)', async () => {
    const w = world();
    assert.equal((await login(w, SECRET_EMAIL.toUpperCase(), 'right-pass')).status, 200);
    assert.equal(w.calls.userIdByUsername.length, 0);
  });
  it('wrong password and unknown username are indistinguishable (same status, body, and one sign-in attempt each)', async () => {
    const w = world();
    const wrong = await login(w, 'liam', 'nope');
    const unknown = await login(w, 'does-not-exist', 'nope');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(await wrong.text(), await unknown.text());
    assert.equal(w.calls.signIn.length, 2, 'unknown users still cost a GoTrue round-trip');
    assert.equal(w.calls.signIn[1].email, legacyEmailFor('does-not-exist'));
  });
  it('legacy accounts (<username>@vexium.ai) are reachable by username', async () => {
    const w = world({ async signIn(email, password) { return email === 'oldtimer@vexium.ai' && password === 'pw' ? { ok: true, session: { access_token: 'X' } } : { ok: false }; } });
    assert.equal((await login(w, 'OldTimer', 'pw')).status, 200);
  });
  it('malformed usernames never reach the database lookup', async () => {
    const w = world();
    await login(w, "x'; drop table profiles;--", 'pw');
    assert.equal(w.calls.userIdByUsername.length, 0);
  });
  it('input validation', async () => {
    const w = world();
    assert.equal((await login(w, '', 'pw')).status, 400);
    assert.equal((await login(w, 'liam', '')).status, 400);
    assert.equal((await login(w, 'x'.repeat(300), 'pw')).status, 400);
    assert.equal((await post(w, { action: 'login', identifier: 5, password: {} })).status, 400);
    assert.equal((await post(w, { action: 'nope' })).status, 400);
    assert.equal((await handle(new Request('https://x', { method: 'POST', body: 'not json' }), w.deps)).status, 400);
    assert.equal((await handle(new Request('https://x', { method: 'GET' }), w.deps)).status, 405);
    assert.equal((await handle(new Request('https://x', { method: 'OPTIONS' }), w.deps)).status, 204);
  });
  it('reports an unconfirmed email only after the password was right', async () => {
    const w = world();
    const r = await login(w, 'unconfirmed@x.co', 'right-pass');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'email_not_confirmed');
  });
  it('brute force one account: 5 failures then 429 with Retry-After, even for the right password', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) assert.equal((await login(w, 'liam', 'bad' + i, `198.51.100.${i}`)).status, 401);
    const blocked = await login(w, 'liam', 'right-pass', '198.51.100.200');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '42');
    assert.equal(w.calls.signIn.length, 5, 'blocked attempts never reach GoTrue');
  });
  it('spraying many usernames from one IP: 20 failures then 429', async () => {
    const w = world();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await login(w, `ghost${i}`, 'bad')).status;
    assert.equal(last, 429);
  });
  it('a rate-limiter outage fails closed (503), never open', async () => {
    const w = world({ async rateHit() { throw new Error('db down'); } });
    assert.equal((await login(w, 'liam', 'right-pass')).status, 503);
    assert.equal(w.calls.signIn.length, 0);
  });
});

describe('auth-gate availability', () => {
  it('answers taken/not-taken, validates input, and is rate limited', async () => {
    const w = world();
    const r = await post(w, { action: 'availability', username: 'liam', email: 'new@x.co' });
    assert.deepEqual(await r.json(), { success: true, username_taken: true, email_taken: false });
    assert.equal((await post(w, { action: 'availability', username: 'bad name!', email: 'new@x.co' })).status, 400);
    assert.equal((await post(w, { action: 'availability', username: 'ok', email: 'nope' })).status, 400);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(w, { action: 'availability', username: 'free' + i, email: 'a@b.co' })).status;
    assert.equal(last, 429);
  });
});

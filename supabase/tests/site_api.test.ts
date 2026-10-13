// site-api unit tests — run:  node --test supabase/tests/site_api.test.ts   (Node ≥ 22.18 runs .ts directly)
// Exercises the real handler/rules/passwords code against an in-memory Store. The live-prod equivalent is
// supabase/tests/step4_abuse.py (same scenarios over HTTP).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, type DataRow, type Deps, type ProjectInfo, type SiteUserRow, type Store } from '../functions/site-api/handler.ts';
import { DUMMY_HASH, fromB64, hashPassword, newToken, sha256Hex, verifyPassword } from '../functions/site-api/passwords.ts';
import { cleanMetadata, normEmail, parseBackend, validateData } from '../functions/site-api/rules.ts';

// ── fake world ──────────────────────────────────────────────────────────────────────────────────────

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const BACKEND = {
  collections: [
    { id: 'waitlist', read: 'owner', write: 'public', fields: [{ key: 'email', type: 'email', required: true }, { key: 'name', type: 'text', max: 40 }], notify_owner: true },
    { id: 'notes', read: 'user', write: 'user', fields: [{ key: 'text', type: 'text', required: true }, { key: 'done', type: 'boolean' }] },
    { id: 'guestbook', read: 'public', write: 'public', max_rows: 3 },
    { id: 'readonly', read: 'public', write: 'owner' },
    { id: 'defaults', fields: [{ key: 'x', type: 'text' }] },
  ],
  auth: { enabled: true },
};

interface World {
  deps: Deps;
  store: Store & { rows: (DataRow & { project_id: string; collection: string; site_user_id: string | null })[]; users: (SiteUserRow & { project_id: string })[]; sessions: Map<string, { project_id: string; site_user_id: string; expires_at: string }> };
  mail: { to: string; subject: string; text: string; replyTo?: string }[];
  clock: { t: number };
  projects: Map<string, ProjectInfo>;
}

function makeWorld(backend: unknown = BACKEND): World {
  const clock = { t: Date.parse('2026-10-13T12:00:00Z') };
  const projects = new Map<string, ProjectInfo>([
    ['proj_a', { id: 'proj_a', user_id: OWNER_ID, name: 'Alpha Bakery', backend }],
    ['proj_b', { id: 'proj_b', user_id: OWNER_ID, name: 'Beta', backend }],
    ['proj_none', { id: 'proj_none', user_id: OWNER_ID, name: 'No backend', backend: null }],
  ]);
  const rows: World['store']['rows'] = [];
  const users: World['store']['users'] = [];
  const sessions: World['store']['sessions'] = new Map();
  const counters = new Map<string, number>();
  const mail: World['mail'] = [];
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  const store = {
    rows, users, sessions,
    async getProject(id: string) { return projects.get(id) ?? null; },
    async getSiteUserByEmail(p: string, email: string) { return users.find((u) => u.project_id === p && u.email === email) ?? null; },
    async createSiteUser(p: string, email: string, hash: string, metadata: Record<string, unknown>) {
      if (users.some((u) => u.project_id === p && u.email === email)) return 'exists' as const;
      const u = { id: uuid(), project_id: p, email, password_hash: hash, metadata };
      users.push(u);
      return { id: u.id, email };
    },
    async createSession(h: string, p: string, uid: string, exp: string) { sessions.set(h, { project_id: p, site_user_id: uid, expires_at: exp }); },
    async getSession(h: string, p: string, nowIso: string) {
      const s = sessions.get(h);
      if (!s || s.project_id !== p || s.expires_at <= nowIso) return null;
      const u = users.find((x) => x.id === s.site_user_id);
      return u ? { site_user_id: u.id, email: u.email, metadata: u.metadata } : null;
    },
    async deleteSession(h: string, p: string) { if (sessions.get(h)?.project_id === p) sessions.delete(h); },
    async countRows(p: string, c: string) { return rows.filter((r) => r.project_id === p && r.collection === c).length; },
    async insertRow(p: string, c: string, data: Record<string, unknown>, uid: string | null) {
      const r = { id: uuid(), project_id: p, collection: c, data, site_user_id: uid, created_at: new Date(clock.t + rows.length).toISOString() };
      rows.push(r);
      return { id: r.id };
    },
    async listRows(p: string, c: string, o: { userId?: string; limit: number; beforeIso?: string }) {
      return rows
        .filter((r) => r.project_id === p && r.collection === c && (!o.userId || r.site_user_id === o.userId) && (!o.beforeIso || r.created_at < o.beforeIso))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, o.limit)
        .map(({ id, data, created_at }) => ({ id, data, created_at }));
    },
    async getOwnRow(p: string, c: string, id: string, uid: string) {
      const r = rows.find((x) => x.id === id && x.project_id === p && x.collection === c && x.site_user_id === uid);
      return r ? { id: r.id, data: r.data, created_at: r.created_at } : null;
    },
    async updateRow(p: string, c: string, id: string, uid: string, data: Record<string, unknown>) {
      const r = rows.find((x) => x.id === id && x.project_id === p && x.collection === c && x.site_user_id === uid);
      if (!r) return false;
      r.data = data;
      return true;
    },
    async deleteRow(p: string, c: string, id: string, uid: string) {
      const i = rows.findIndex((x) => x.id === id && x.project_id === p && x.collection === c && x.site_user_id === uid);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async rateHit(key: string, win: number, limit: number, cost: number) {
      const w = Math.floor(clock.t / 1000 / win);
      const k = `${key}|${w}`;
      const hits = (counters.get(k) ?? 0) + cost;
      counters.set(k, hits);
      return { allowed: cost > 0 ? hits <= limit : hits < limit, hits, retry_after: Math.max(1, (w + 1) * win - Math.floor(clock.t / 1000)) };
    },
    async ownerEmail(uid: string) { return uid === OWNER_ID ? 'owner@example.com' : null; },
  };

  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    store, now: () => clock.t,
    waitUntil: (p) => { pending.push(p); },
    async sendMail(m) { mail.push(m); },
  };
  (deps as Deps & { flush: () => Promise<unknown> }).flush = () => Promise.all(pending.splice(0));
  return { deps, store, mail, clock, projects };
}

const flush = (w: World) => (w.deps as Deps & { flush: () => Promise<unknown> }).flush();

async function call(w: World, body: Record<string, unknown>, headers: Record<string, string> = {}, project = 'proj_a') {
  const res = await handle(
    new Request('https://api.test/site-api', { method: 'POST', body: JSON.stringify({ project_id: project, ...body }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers } }),
    w.deps,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
}

const PW = 'correct horse battery';
async function signup(w: World, email = 'alice@example.com', project = 'proj_a', ip = '203.0.113.7') {
  const r = await call(w, { action: 'signup', email, password: PW }, { 'cf-connecting-ip': ip }, project);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { token: string; user: { id: string; email: string } };
}

// ── passwords ────────────────────────────────────────────────────────────────────────────────────────

describe('passwords', () => {
  it('hash/verify round-trip with salt, wrong password fails', async () => {
    const a = await hashPassword('hunter22hunter', 100_000);
    const b = await hashPassword('hunter22hunter', 100_000);
    assert.notEqual(a, b, 'per-user salt');
    assert.match(a, /^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword('hunter22hunter', a), true);
    assert.equal(await verifyPassword('hunter22hunteR', a), false);
  });
  it('default cost is 600 000 iterations', async () => {
    assert.match(await hashPassword('x'.repeat(8)), /^pbkdf2\$sha256\$600000\$/);
  });
  it('rejects garbage, legacy sha256 hex, absurd iteration counts (never throws)', async () => {
    for (const bad of ['', 'abc', 'a'.repeat(64), 'pbkdf2$sha256$600000$!!$!!', 'pbkdf2$sha256$5$AAAA$AAAA', 'pbkdf2$sha256$99999999$AAAA$AAAA', 'pbkdf2$sha1$600000$AAAA$AAAA']) {
      assert.equal(await verifyPassword('x', bad), false, bad);
    }
    assert.equal(await verifyPassword('x', undefined as unknown as string), false);
  });
  it('DUMMY_HASH is well formed (so unknown emails cost a full PBKDF2) and matches nothing', async () => {
    const [, , iters, salt, hash] = DUMMY_HASH.split('$');
    assert.equal(Number(iters), 600_000);
    assert.equal(fromB64(salt).length, 16);
    assert.equal(fromB64(hash).length, 32);
    assert.equal(await verifyPassword('', DUMMY_HASH), false);
    assert.equal(await verifyPassword('password', DUMMY_HASH), false);
  });
  it('session tokens: 256 bits, unique, prefixed; hashing is stable', async () => {
    const t = newToken();
    assert.match(t, /^vxs_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, newToken());
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────

describe('parseBackend', () => {
  it('defaults: write public; read user when accounts on, else owner', () => {
    const on = parseBackend({ collections: [{ id: 'a' }], auth: { enabled: true } });
    assert.deepEqual([on.collections.get('a')!.read, on.collections.get('a')!.write], ['user', 'public']);
    const off = parseBackend({ collections: [{ id: 'a' }], auth: { enabled: false } });
    assert.equal(off.collections.get('a')!.read, 'owner');
    assert.equal(off.authEnabled, false);
  });
  it('accepts a JSON string (how the editor stores _backend) and survives garbage', () => {
    assert.equal(parseBackend(JSON.stringify({ collections: [{ id: 'x' }] })).collections.size, 1);
    for (const g of [null, undefined, '', 'not json', 42, [], '[]', { collections: 'nope' }, { collections: [null, 5, 'x'] }]) {
      assert.equal(parseBackend(g).collections.size, 0, String(g));
    }
  });
  it('drops reserved / malformed / duplicate collection ids; invalid access values fall back to defaults', () => {
    const b = parseBackend({ collections: [{ id: 'transactions' }, { id: '_x' }, { id: 'Has Space' }, { id: '../a' }, { id: 'OK' }, { id: 'ok' }, { id: 'p', read: 'everyone', write: 'root' }] });
    assert.deepEqual([...b.collections.keys()], ['ok', 'p']);
    assert.deepEqual([b.collections.get('p')!.read, b.collections.get('p')!.write], ['owner', 'public']);
  });
  it('max_rows is clamped', () => {
    const b = parseBackend({ collections: [{ id: 'a', max_rows: 5 }, { id: 'b', max_rows: 10 ** 9 }, { id: 'c', max_rows: -3 }, { id: 'd', max_rows: 'x' }] });
    assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => b.collections.get(k)!.maxRows), [5, 100_000, 10_000, 10_000]);
  });
});

describe('validateData', () => {
  const c = parseBackend({ collections: [{ id: 'f', fields: [
    { key: 'email', type: 'email', required: true }, { key: 'age', type: 'number' }, { key: 'ok', type: 'checkbox' },
    { key: 'site', type: 'url' }, { key: 'name', type: 'text', max: 10 }, { key: 'msg', type: 'textarea' },
  ] }] }).collections.get('f')!;

  it('keeps declared fields only and reports ignored keys', () => {
    const r = validateData(c, { email: 'a@b.co', evil: 1, __proto__x: 2 });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { email: 'a@b.co' });
    assert.deepEqual(r.ignored, ['evil', '__proto__x']);
  });
  it('required + type checks', () => {
    assert.equal(validateData(c, {}).ok, false);
    assert.equal(validateData(c, { email: 'nope' }).ok, false);
    assert.equal(validateData(c, { email: 'a@b.co', age: 'abc' }).ok, false);
    assert.equal(validateData(c, { email: 'a@b.co', site: 'javascript:alert(1)' }).ok, false);
    assert.equal(validateData(c, { email: 'a@b.co', name: 'x'.repeat(11) }).ok, false);
    const ok = validateData(c, { email: ' A@B.co ', age: '42', ok: 'on', site: 'https://x.io', name: 'Al', msg: 'hi' });
    assert.ok(ok.ok);
    assert.deepEqual(ok.data, { email: 'A@B.co', age: 42, ok: true, site: 'https://x.io', name: 'Al', msg: 'hi' });
  });
  it('non-objects are rejected; huge rows get 413', () => {
    for (const bad of [null, undefined, 'x', 5, [], [1]]) assert.equal(validateData(c, bad).ok, false);
    const big = validateData(c, { email: 'a@b.co', msg: 'x'.repeat(5000), name: 'x' });
    assert.ok(big.ok);
    const free = parseBackend({ collections: [{ id: 'g' }] }).collections.get('g')!;
    const r = validateData(free, { blob: 'x'.repeat(20_000) });
    assert.ok(!r.ok && r.status === 413);
  });
  it('free-form collections: strips NUL and prototype keys, bounds depth', () => {
    const free = parseBackend({ collections: [{ id: 'g' }] }).collections.get('g')!;
    const r = validateData(free, JSON.parse('{"a":"x\\u0000y","__proto__":{"p":1},"constructor":1,"n":{"n":{"n":{"n":{"n":{"n":{"deep":1}}}}}}}'));
    assert.ok(r.ok);
    assert.equal((r.data as any).a, 'xy');
    assert.equal(Object.prototype.hasOwnProperty.call(r.data, '__proto__'), false);
    assert.equal('constructor' in r.data && Object.prototype.hasOwnProperty.call(r.data, 'constructor'), false);
    assert.equal(JSON.stringify(r.data).includes('deep'), false);
  });
  it('normEmail / cleanMetadata', () => {
    assert.equal(normEmail('  Bob@Example.COM '), 'bob@example.com');
    for (const bad of ['', 'a', 'a@b', 'a b@c.co', 5, null, 'x'.repeat(260) + '@a.co']) assert.equal(normEmail(bad), null);
    assert.deepEqual(cleanMetadata(undefined), {});
    assert.deepEqual(cleanMetadata({ plan: 'pro', n: 1, ok: true }), { plan: 'pro', n: 1, ok: true });
    for (const bad of [[], 'x', { a: { b: 1 } }, { a: [1] }, { 'bad key!': 1 }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))]) assert.equal(cleanMetadata(bad), null);
  });
});

// ── handler: basics ──────────────────────────────────────────────────────────────────────────────────

describe('request handling', () => {
  it('CORS preflight, 405, bad bodies, unknown site, unknown action', async () => {
    const w = makeWorld();
    const pre = await handle(new Request('https://api.test/', { method: 'OPTIONS' }), w.deps);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal((await handle(new Request('https://api.test/', { method: 'GET' }), w.deps)).status, 405);
    const raw = (b: string, h: Record<string, string> = {}) => handle(new Request('https://api.test/', { method: 'POST', body: b, headers: h }), w.deps);
    assert.equal((await raw('not json')).status, 400);
    assert.equal((await raw('[1,2]')).status, 400);
    assert.equal((await call(w, { action: 'submit' }, {}, 'bad id!')).status, 400);
    assert.equal((await call(w, { action: 'submit' }, {}, 'proj_nope')).status, 404);
    assert.equal((await call(w, { action: 'nope' })).status, 400);
    assert.equal((await call(w, { project_id: undefined as unknown as string })).status, 400);
  });
  it('oversize bodies → 413 (declared and streamed)', async () => {
    const w = makeWorld();
    const big = JSON.stringify({ project_id: 'proj_a', action: 'submit', collection: 'waitlist', data: { email: 'a@b.co', pad: 'x'.repeat(70_000) } });
    assert.equal((await handle(new Request('https://api.test/', { method: 'POST', body: big }), w.deps)).status, 413);
    assert.equal((await handle(new Request('https://api.test/', { method: 'POST', body: big, headers: { 'content-length': '10' } }), w.deps)).status, 413);
  });
  it('a project with no _backend exposes nothing', async () => {
    const w = makeWorld();
    assert.equal((await call(w, { action: 'submit', collection: 'anything', data: {} }, {}, 'proj_none')).status, 404);
    assert.equal((await call(w, { action: 'signup', email: 'a@b.co', password: PW }, {}, 'proj_none')).status, 403);
  });
});

// ── handler: collections ─────────────────────────────────────────────────────────────────────────────

describe('collection rules', () => {
  it('unknown / reserved / malformed collections', async () => {
    const w = makeWorld();
    assert.equal((await call(w, { action: 'submit', collection: 'nope', data: {} })).status, 404);
    assert.equal((await call(w, { action: 'get_data', collection: 'nope' })).status, 404);
    for (const name of ['transactions', 'Transactions', ' TRANSACTIONS ', '_backend']) {
      assert.equal((await call(w, { action: 'submit', collection: name, data: { amount: 1e6 } })).status, 403, name);
      assert.equal((await call(w, { action: 'get_data', collection: name })).status, 403, name);
    }
    assert.equal((await call(w, { action: 'submit', collection: '../etc', data: {} })).status, 400);
    assert.equal((await call(w, { action: 'submit', data: {} })).status, 400);
    assert.equal(w.store.rows.length, 0);
  });
  it('even if a site declares "transactions" itself, it stays blocked', async () => {
    const w = makeWorld({ collections: [{ id: 'transactions', write: 'public', read: 'public' }], auth: { enabled: false } });
    assert.equal((await call(w, { action: 'submit', collection: 'transactions', data: { a: 1 } })).status, 403);
    assert.equal((await call(w, { action: 'get_data', collection: 'transactions' })).status, 403);
  });
  it('write:public — anyone submits, valid rows only, response lists ignored keys', async () => {
    const w = makeWorld();
    const ok = await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'x@y.co', extra: 'dropped' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.ignored, ['extra']);
    assert.deepEqual(w.store.rows[0].data, { email: 'x@y.co' });
    assert.equal((await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'nope' } })).status, 400);
    assert.equal((await call(w, { action: 'submit', collection: 'waitlist', data: 'str' })).status, 400);
  });
  it('read:owner — nobody reads over the API, not even the submitter or a signed-in user', async () => {
    const w = makeWorld();
    const u = await signup(w);
    await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'x@y.co' } });
    assert.equal((await call(w, { action: 'get_data', collection: 'waitlist' })).status, 403);
    assert.equal((await call(w, { action: 'get_data', collection: 'waitlist', token: u.token })).status, 403);
  });
  it('write:owner — API refuses submit/update/delete; read:public lists', async () => {
    const w = makeWorld();
    const u = await signup(w);
    w.store.rows.push({ id: '00000000-0000-4000-8000-0000000000aa', project_id: 'proj_a', collection: 'readonly', data: { a: 1 }, site_user_id: null, created_at: '2026-01-01T00:00:00Z' });
    assert.equal((await call(w, { action: 'submit', collection: 'readonly', data: { a: 2 } })).status, 403);
    assert.equal((await call(w, { action: 'update', collection: 'readonly', id: '00000000-0000-4000-8000-0000000000aa', data: {}, token: u.token })).status, 403);
    assert.equal((await call(w, { action: 'delete', collection: 'readonly', id: '00000000-0000-4000-8000-0000000000aa', token: u.token })).status, 403);
    const l = await call(w, { action: 'get_data', collection: 'readonly' });
    assert.equal(l.status, 200);
    assert.equal(l.body.rows.length, 1);
  });
  it('defaults when read/write omitted: public submit, own-rows read (accounts on)', async () => {
    const w = makeWorld();
    assert.equal((await call(w, { action: 'submit', collection: 'defaults', data: { x: 'hi' } })).status, 200);
    assert.equal((await call(w, { action: 'get_data', collection: 'defaults' })).status, 401);
  });
  it('max_rows cap → 409', async () => {
    const w = makeWorld();
    for (let i = 0; i < 3; i++) assert.equal((await call(w, { action: 'submit', collection: 'guestbook', data: { n: i } }, { 'cf-connecting-ip': `10.0.0.${i}` })).status, 200);
    const r = await call(w, { action: 'submit', collection: 'guestbook', data: { n: 9 } }, { 'cf-connecting-ip': '10.0.0.9' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'collection_full');
  });
  it('rows are scoped to the project — the same collection name on another site is separate', async () => {
    const w = makeWorld();
    await call(w, { action: 'submit', collection: 'guestbook', data: { n: 1 } });
    const other = await call(w, { action: 'get_data', collection: 'guestbook' }, {}, 'proj_b');
    assert.equal(other.body.rows.length, 0);
  });
  it('list: limit clamp, newest first, cursor pagination, bad cursor', async () => {
    const w = makeWorld({ collections: [{ id: 'many', read: 'public', write: 'public', max_rows: 500 }], auth: { enabled: false } });
    for (let i = 0; i < 5; i++) await w.store.insertRow('proj_a', 'many', { n: i }, null);
    const all = await call(w, { action: 'list', collection: 'many', limit: 9999 });
    assert.deepEqual(all.body.rows.map((r: DataRow) => r.data.n), [4, 3, 2, 1, 0]);
    const p1 = await call(w, { action: 'list', collection: 'many', limit: 2 });
    assert.equal(p1.body.rows.length, 2);
    assert.ok(p1.body.next_before);
    const p2 = await call(w, { action: 'list', collection: 'many', limit: 2, before: p1.body.next_before });
    assert.deepEqual(p2.body.rows.map((r: DataRow) => r.data.n), [2, 1]);
    assert.equal((await call(w, { action: 'list', collection: 'many', before: 'garbage' })).status, 400);
  });
});

// ── handler: accounts + sessions ─────────────────────────────────────────────────────────────────────

describe('accounts', () => {
  it('signup stores a PBKDF2 hash (never the password) and only a hash of the token', async () => {
    const w = makeWorld();
    const u = await signup(w);
    assert.match(w.store.users[0].password_hash, /^pbkdf2\$sha256\$600000\$/);
    assert.ok(!w.store.users[0].password_hash.includes(PW));
    assert.match(u.token, /^vxs_/);
    assert.ok(!w.store.sessions.has(u.token), 'raw token must not be a key');
    assert.ok(w.store.sessions.has(await sha256Hex(u.token)));
    assert.equal(u.user.email, 'alice@example.com');
  });
  it('signup validation, duplicate, accounts disabled', async () => {
    const w = makeWorld();
    await signup(w);
    assert.equal((await call(w, { action: 'signup', email: 'bad', password: PW })).status, 400);
    assert.equal((await call(w, { action: 'signup', email: 'b@example.com', password: 'short' })).status, 400);
    assert.equal((await call(w, { action: 'signup', email: 'b@example.com', password: 'x'.repeat(129) })).status, 400);
    assert.equal((await call(w, { action: 'signup', email: 'b@example.com', password: PW, metadata: { a: { b: 1 } } })).status, 400);
    assert.equal((await call(w, { action: 'signup', email: 'ALICE@example.com', password: PW })).status, 409, 'emails are case-insensitive');
    const off = makeWorld({ collections: [], auth: { enabled: false } });
    assert.equal((await call(off, { action: 'signup', email: 'a@b.co', password: PW })).status, 403);
    assert.equal((await call(off, { action: 'login', email: 'a@b.co', password: PW })).status, 403);
  });
  it('login: success, wrong password, unknown email → same 401 message', async () => {
    const w = makeWorld();
    await signup(w);
    const ok = await call(w, { action: 'login', email: 'Alice@Example.com', password: PW });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^vxs_/);
    const wrong = await call(w, { action: 'login', email: 'alice@example.com', password: 'wrong password' });
    const none = await call(w, { action: 'login', email: 'nobody@example.com', password: 'wrong password' });
    assert.equal(wrong.status, 401);
    assert.equal(none.status, 401);
    assert.equal(wrong.body.error, none.body.error);
    assert.equal((await call(w, { action: 'login', email: 'alice@example.com' })).status, 400);
  });
  it('brute force: 5 failures per (site,email) then 429 + Retry-After — even for the right password', async () => {
    const w = makeWorld();
    await signup(w);
    for (let i = 0; i < 5; i++) {
      // rotate IPs so only the per-email limit can trigger
      assert.equal((await call(w, { action: 'login', email: 'alice@example.com', password: 'nope nope' + i }, { 'cf-connecting-ip': `198.51.100.${i}` })).status, 401);
    }
    const blocked = await call(w, { action: 'login', email: 'alice@example.com', password: PW }, { 'cf-connecting-ip': '198.51.100.99' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    // another account on the same site is unaffected
    await signup(w, 'carol@example.com', 'proj_a', '192.0.2.1');
    assert.equal((await call(w, { action: 'login', email: 'carol@example.com', password: PW }, { 'cf-connecting-ip': '192.0.2.1' })).status, 200);
    // window rolls over
    w.clock.t += 16 * 60 * 1000;
    assert.equal((await call(w, { action: 'login', email: 'alice@example.com', password: PW }, { 'cf-connecting-ip': '198.51.100.99' })).status, 200);
  });
  it('brute force across many emails from one IP: 30 failures then 429', async () => {
    const w = makeWorld();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(w, { action: 'login', email: `ghost${i}@example.com`, password: 'nope nope' })).status;
    assert.equal(last, 429);
  });
  it('signup spam: 5 per IP per hour', async () => {
    const w = makeWorld();
    for (let i = 0; i < 5; i++) await signup(w, `u${i}@example.com`);
    const r = await call(w, { action: 'signup', email: 'u6@example.com', password: PW });
    assert.equal(r.status, 429);
  });
  it('sessions are bound to ONE project, expire, can be revoked, and garbage → session_expired', async () => {
    const w = makeWorld();
    const a = await signup(w);
    assert.equal((await call(w, { action: 'me', token: a.token })).status, 200);
    // token from site A is useless on site B
    const cross = await call(w, { action: 'me', token: a.token }, {}, 'proj_b');
    assert.equal(cross.status, 401);
    assert.equal(cross.body.code, 'session_expired');
    // a row id (the old "token") is not a session
    assert.equal((await call(w, { action: 'me', token: a.user.id })).status, 401);
    for (const junk of ['x', 'vxs_' + 'A'.repeat(43), 'x'.repeat(500), 12345, {}]) {
      assert.equal((await call(w, { action: 'me', token: junk })).status, 401, String(junk));
    }
    // a sent-but-bad token is rejected on public endpoints too (no silent downgrade to anonymous)
    assert.equal((await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'a@b.co' }, token: 'bogus' })).status, 401);
    // logout revokes
    await call(w, { action: 'logout', token: a.token });
    assert.equal((await call(w, { action: 'me', token: a.token })).status, 401);
    // expiry
    const b = await call(w, { action: 'login', email: 'alice@example.com', password: PW });
    w.clock.t += 31 * 24 * 3600 * 1000;
    assert.equal((await call(w, { action: 'me', token: b.body.token })).status, 401);
  });
  it('logout of another site cannot revoke this site\'s session', async () => {
    const w = makeWorld();
    const a = await signup(w);
    await call(w, { action: 'logout', token: a.token }, {}, 'proj_b');
    assert.equal((await call(w, { action: 'me', token: a.token })).status, 200);
  });
});

// ── handler: user-scoped data ────────────────────────────────────────────────────────────────────────

describe('user collections', () => {
  it('write:user needs a session; rows are attributed; list returns ONLY own rows', async () => {
    const w = makeWorld();
    const a = await signup(w, 'alice@example.com', 'proj_a', '10.1.1.1');
    const b = await signup(w, 'bob@example.com', 'proj_a', '10.1.1.2');
    assert.equal((await call(w, { action: 'submit', collection: 'notes', data: { text: 'anon' } })).status, 401);
    await call(w, { action: 'submit', collection: 'notes', data: { text: 'alice 1' }, token: a.token });
    await call(w, { action: 'submit', collection: 'notes', data: { text: 'alice 2' }, token: a.token });
    await call(w, { action: 'submit', collection: 'notes', data: { text: 'bob 1' }, token: b.token });
    assert.equal((await call(w, { action: 'list', collection: 'notes' })).status, 401);
    const la = await call(w, { action: 'list', collection: 'notes', token: a.token });
    assert.deepEqual(la.body.rows.map((r: DataRow) => r.data.text).sort(), ['alice 1', 'alice 2']);
    const lb = await call(w, { action: 'list', collection: 'notes', token: b.token });
    assert.deepEqual(lb.body.rows.map((r: DataRow) => r.data.text), ['bob 1']);
  });
  it('update/delete only touch the caller\'s own rows (merge semantics, validation applies)', async () => {
    const w = makeWorld();
    const a = await signup(w, 'alice@example.com', 'proj_a', '10.1.1.1');
    const b = await signup(w, 'bob@example.com', 'proj_a', '10.1.1.2');
    const mine = (await call(w, { action: 'submit', collection: 'notes', data: { text: 'mine', done: false }, token: a.token })).body.id;
    const theirs = (await call(w, { action: 'submit', collection: 'notes', data: { text: 'theirs' }, token: b.token })).body.id;

    assert.equal((await call(w, { action: 'update', collection: 'notes', id: theirs, data: { text: 'pwned' }, token: a.token })).status, 404);
    assert.equal((await call(w, { action: 'delete', collection: 'notes', id: theirs, token: a.token })).status, 404);
    assert.equal(w.store.rows.find((r) => r.id === theirs)!.data.text, 'theirs');

    assert.equal((await call(w, { action: 'update', collection: 'notes', id: mine, data: { done: true }, token: a.token })).status, 200);
    assert.deepEqual(w.store.rows.find((r) => r.id === mine)!.data, { text: 'mine', done: true });
    assert.equal((await call(w, { action: 'update', collection: 'notes', id: mine, data: { text: '' }, token: a.token })).status, 400, 'required field cannot be blanked');
    assert.equal((await call(w, { action: 'update', collection: 'notes', id: 'not-a-uuid', data: {}, token: a.token })).status, 400);
    assert.equal((await call(w, { action: 'update', collection: 'notes', id: mine, data: { done: true } })).status, 401);
    assert.equal((await call(w, { action: 'delete', collection: 'notes', id: mine })).status, 401);

    assert.equal((await call(w, { action: 'delete', collection: 'notes', id: mine, token: a.token })).status, 200);
    assert.equal(w.store.rows.some((r) => r.id === mine), false);
  });
  it('a user of site B cannot touch site A rows even with a valid B session and A\'s row id', async () => {
    const w = makeWorld();
    const a = await signup(w, 'alice@example.com', 'proj_a', '10.1.1.1');
    const b = await signup(w, 'alice@example.com', 'proj_b', '10.1.1.2');
    const row = (await call(w, { action: 'submit', collection: 'notes', data: { text: 'A' }, token: a.token })).body.id;
    assert.equal((await call(w, { action: 'delete', collection: 'notes', id: row, token: b.token }, {}, 'proj_b')).status, 404);
    assert.equal((await call(w, { action: 'delete', collection: 'notes', id: row, token: b.token }, {}, 'proj_a')).status, 401);
    assert.equal(w.store.rows.length, 1);
  });
});

// ── handler: abuse limits ────────────────────────────────────────────────────────────────────────────

describe('submit limits', () => {
  it('30 submits / 10 min per IP per collection, then 429; other IPs and collections unaffected; resets later', async () => {
    const w = makeWorld({ collections: [{ id: 'a', max_rows: 1000 }, { id: 'b', max_rows: 1000 }], auth: { enabled: false } });
    for (let i = 0; i < 30; i++) assert.equal((await call(w, { action: 'submit', collection: 'a', data: { i } })).status, 200);
    const blocked = await call(w, { action: 'submit', collection: 'a', data: { i: 99 } });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await call(w, { action: 'submit', collection: 'a', data: { i: 99 } }, { 'cf-connecting-ip': '203.0.113.99' })).status, 200);
    assert.equal((await call(w, { action: 'submit', collection: 'b', data: { i: 1 } })).status, 200);
    w.clock.t += 11 * 60 * 1000;
    assert.equal((await call(w, { action: 'submit', collection: 'a', data: { i: 100 } })).status, 200);
  });
  it('public reads: 120 / min per IP', async () => {
    const w = makeWorld();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await call(w, { action: 'get_data', collection: 'guestbook' })).status;
    assert.equal(last, 429);
  });
  it('rate-limiter outage fails CLOSED (503), not open', async () => {
    const w = makeWorld();
    w.store.rateHit = async () => { throw new Error('db down'); };
    assert.equal((await call(w, { action: 'submit', collection: 'guestbook', data: { n: 1 } })).status, 503);
    assert.equal(w.store.rows.length, 0);
  });
  it('declared-field oversize and free-form oversize are rejected before touching the DB', async () => {
    const w = makeWorld();
    assert.equal((await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'a@b.co', name: 'x'.repeat(41) } })).status, 400);
    assert.equal((await call(w, { action: 'submit', collection: 'guestbook', data: { blob: 'x'.repeat(20_000) } })).status, 413);
    assert.equal(w.store.rows.length, 0);
  });
});

// ── forms → email ────────────────────────────────────────────────────────────────────────────────────

describe('notify_owner', () => {
  it('mails the OWNER (never a caller-supplied address), plain text, reply-to = submitted email', async () => {
    const w = makeWorld();
    await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'fan@example.com', name: 'Fan' }, to: 'attacker@evil.test', recipient: 'attacker@evil.test' });
    await flush(w);
    assert.equal(w.mail.length, 1);
    assert.equal(w.mail[0].to, 'owner@example.com');
    assert.equal(w.mail[0].replyTo, 'fan@example.com');
    assert.match(w.mail[0].subject, /^New waitlist submission — Alpha Bakery$/);
    assert.match(w.mail[0].text, /email: fan@example\.com/);
    assert.ok(!JSON.stringify(w.mail).includes('attacker'));
  });
  it('is throttled to 20 / hour / project and a mail failure never fails the submit', async () => {
    const w = makeWorld({ collections: [{ id: 'waitlist', notify_owner: true, max_rows: 1000, fields: [{ key: 'email', type: 'email' }] }], auth: { enabled: false } });
    for (let i = 0; i < 25; i++) {
      assert.equal((await call(w, { action: 'submit', collection: 'waitlist', data: { email: `f${i}@example.com` } }, { 'cf-connecting-ip': `10.9.9.${i}` })).status, 200);
    }
    await flush(w);
    assert.equal(w.mail.length, 20);
    const w2 = makeWorld();
    w2.deps.sendMail = async () => { throw new Error('resend down'); };
    assert.equal((await call(w2, { action: 'submit', collection: 'waitlist', data: { email: 'a@b.co' } })).status, 200);
    await flush(w2);
  });
  it('header-injection attempts in names cannot reach the subject', async () => {
    const w = makeWorld({ collections: [{ id: 'waitlist', notify_owner: true }], auth: { enabled: false } });
    w.projects.get('proj_a')!.name = 'Evil\r\nBcc: x@y.z';
    await call(w, { action: 'submit', collection: 'waitlist', data: { email: 'a@b.co' } });
    await flush(w);
    assert.ok(!/[\r\n]/.test(w.mail[0].subject));
  });
});

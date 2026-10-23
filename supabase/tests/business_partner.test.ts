// BUSINESS partner (Step 13, chunk C) — run:  node --test supabase/tests/business_partner.test.ts
// The grounding rules (_shared/advice.ts) and the business-partner handler against an in-memory fake with a scripted "model".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BusinessState } from '../functions/_shared/artifacts.ts';
import { factsOf, groundAdvice, numbersAreGrounded, numbersIn, parseReply, partnerPrompt, PARTNER_MARK, MAX_RECOMMENDATIONS } from '../functions/_shared/advice.ts';
import { buildBusinessState, type RawStats } from '../functions/_shared/business.ts';
import { ASKS_PER_HOUR, handle, ModelError, NOT_ENOUGH, STATE_MAX_AGE_MS, type Deps, type ModelReply, type ProjectRow, type SavedArtifact } from '../functions/business-partner/handler.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const DAYS = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAYS);

function busy(): RawStats {
  return {
    days: 30,
    traffic: {
      views: 400, visitors: 120, sessions: 150, prev_views: 250, prev_visitors: 80,
      pages: [{ page: '/', views: 250, visitors: 110 }, { page: '/shop.html', views: 100, visitors: 50 }],
      sources: [{ source: '', visitors: 40 }, { source: 'www.google.com', visitors: 30 }, { source: 'l.facebook.com', visitors: 20 }],
      devices: [{ device: 'mobile', visitors: 90 }, { device: 'desktop', visitors: 30 }],
      daily: [{ day: '2026-10-18', views: 10, visitors: 5 }],
    },
    money: {
      current: [{ currency: 'usd', orders: 5, gross_cents: 12500, refunds_cents: -2500, net_cents: 10000 }],
      previous: [{ currency: 'usd', orders: 4, gross_cents: 8000, refunds_cents: 0, net_cents: 8000 }],
      products: [{ name: 'Beans', currency: 'usd', units: 4, cents: 10000 }, { name: 'Mug', currency: 'usd', units: 1, cents: 2500 }],
    },
    signups: { current: 4, previous: 2 },
    leads: { current: 3, previous: 3, by_collection: [{ collection: 'bookings', count: 2 }] },
    lifetime: { views: 900, first_view_at: '2026-09-01T00:00:00Z', orders: 12, signups: 9, leads: 8 },
    recent: [],
  };
}
const okState = (): BusinessState => buildBusinessState({
  stats: busy(), now: NOW, firstLiveAt: ago(40), sells: true,
  scenario: { price_cents: 2000, monthly_visitors: 500, conversion_pct: 2 },
});
const quietState = (): BusinessState => buildBusinessState({ stats: { days: 30, traffic: { visitors: 0, views: 0 } }, now: NOW, firstLiveAt: ago(3) });
const earlyState = (): BusinessState => buildBusinessState({ stats: { days: 30, traffic: { visitors: 12, views: 20 }, lifetime: { views: 20, orders: 0, signups: 0, leads: 0 } }, now: NOW, firstLiveAt: ago(2) });

describe('factsOf', () => {
  const st = okState();
  const facts = factsOf(st);
  const byId = Object.fromEntries(facts.map((f) => [f.id, f.text]));
  it('puts the state\'s own numbers in plain statements with stable ids', () => {
    assert.match(byId.visitors!, /Visitors: 120 \(80 in the 30 days before, \+50%\)/);
    assert.match(byId.orders!, /Orders: 5 \(4 in the 30 days before, \+25%\)/);
    assert.match(byId.revenue!, /\$100\.00/);
    assert.match(byId['source.1']!, /Visitors from (Google|Direct): 40, 33% of visitors/);
    assert.match(byId['product.1']!, /Beans: 4 sales, \$100\.00/);
    assert.match(byId['page.2']!, /\/shop\.html: 100 views from 50 visitors/);
    assert.ok(byId['plan.traffic'], 'the plan comparison is a fact');
    assert.ok(Object.keys(byId).some((k) => k.startsWith('insight.')), 'the server\'s insights are facts');
  });
  it('has no duplicate ids', () => {
    assert.equal(new Set(facts.map((f) => f.id)).size, facts.length);
  });
  it('says nothing about a change the state has no number for', () => {
    const q = Object.fromEntries(factsOf(quietState()).map((f) => [f.id, f.text]));
    assert.doesNotMatch(q.visitors!, /before/);
    assert.equal(q.conversion, undefined);
    assert.equal(q.revenue, undefined);
  });
});

describe('numbers', () => {
  it('reads money, percentages and plain numbers', () => {
    assert.deepEqual(numbersIn('$1,200.50 and 33% of 412'), [
      { value: 1200.5, money: true, percent: false }, { value: 33, money: false, percent: true }, { value: 412, money: false, percent: false },
    ]);
  });
  it('allows a fact\'s number however it is written, and small counts', () => {
    const ok = new Set(['money:100', 'plain:120', 'percent:33']);
    assert.ok(numbersAreGrounded('You made $100 from 120 visitors', ok));
    assert.ok(numbersAreGrounded('33% came from Google', ok));
    assert.ok(numbersAreGrounded('Try 3 small changes to 2 pages', ok));
  });
  it('refuses numbers the facts do not contain', () => {
    const ok = new Set(['money:100', 'plain:120']);
    assert.ok(!numbersAreGrounded('Visitors will reach 500', ok));
    assert.ok(!numbersAreGrounded('That is $7 per visitor', ok));
    assert.ok(!numbersAreGrounded('A 5% lift', ok)); // a percentage is never a free "count"
    assert.ok(!numbersAreGrounded('That is 100% sure', ok)); // …nor a fact\'s $100 reused as a percentage
    assert.ok(!numbersAreGrounded('You made 100 dollars', ok)); // …nor a plain number standing in for money
    assert.ok(!numbersAreGrounded('about 11 pages', ok));
  });
});

describe('parseReply', () => {
  it('finds the JSON in a fence or a sentence', () => {
    assert.deepEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseReply('Sure! {"a":{"b":2}} Hope that helps.'), { a: { b: 2 } });
  });
  it('is null for anything else', () => {
    assert.equal(parseReply('no json here'), null);
    assert.equal(parseReply('{broken'), null);
    assert.equal(parseReply('[1,2]'), null);
  });
});

describe('groundAdvice', () => {
  const facts = factsOf(okState());
  const rec = (over: Record<string, unknown> = {}) => ({
    id: 'shop-cta', title: 'Make the shop button easier to find', why: 'Half your visitors look at the shop page but few order.', cites: ['page.2', 'orders'], apply: 'Make the Shop button bigger on the home page.', ...over,
  });

  it('keeps a recommendation the facts back up and attaches the facts\' OWN lines as evidence', () => {
    const g = groundAdvice({ headline: 'Visitors are up and sales are steady.', recommendations: [rec()] }, facts);
    assert.equal(g.recommendations.length, 1);
    const r = g.recommendations[0]!;
    assert.equal(r.id, 'shop-cta');
    assert.deepEqual(r.evidence.map((e) => e.id), ['page.2', 'orders']);
    assert.equal(r.evidence[0]!.text, facts.find((f) => f.id === 'page.2')!.text);
    assert.equal(r.apply, 'Make the Shop button bigger on the home page.');
    assert.equal(g.headline, 'Visitors are up and sales are steady.');
    assert.deepEqual(g.dropped, []);
  });
  it('drops a recommendation with a number that is not in the facts — the rest survive', () => {
    const g = groundAdvice({ recommendations: [rec({ why: 'You are 40% short of a good month.' }), rec({ id: 'b', title: 'Thank your first buyers by email' })] }, facts);
    assert.deepEqual(g.recommendations.map((r) => r.id), ['b']);
    assert.match(g.dropped[0]!, /number that is not in the facts/);
  });
  it('accepts a number that IS in the facts, written another way', () => {
    const g = groundAdvice({ recommendations: [rec({ why: 'You earned $100 from 4 sales of Beans — your best seller.' })] }, facts);
    assert.equal(g.recommendations.length, 1);
  });
  it('drops a recommendation that cites nothing, or only facts that do not exist', () => {
    const g = groundAdvice({ recommendations: [rec({ cites: [] }), rec({ cites: ['made.up'] }), rec({ cites: 'visitors' })] }, facts);
    assert.equal(g.recommendations.length, 0);
    assert.equal(g.dropped.length, 3);
  });
  it('ignores unknown cites but keeps the known ones, no duplicates', () => {
    const g = groundAdvice({ recommendations: [rec({ cites: ['visitors', 'nope', 'visitors'] })] }, facts);
    assert.deepEqual(g.recommendations[0]!.evidence.map((e) => e.id), ['visitors']);
  });
  it('removes only the change when it states a price or percentage that is not a fact', () => {
    const g = groundAdvice({ recommendations: [rec({ apply: 'Put “Only $9” next to the Shop button.' })] }, facts);
    assert.equal(g.recommendations.length, 1);
    assert.equal(g.recommendations[0]!.apply, null);
    assert.match(g.dropped[0]!, /price or percentage/);
  });
  it('treats "null"/empty apply as no change', () => {
    const g = groundAdvice({ recommendations: [rec({ apply: 'null' }), rec({ id: 'x', title: 'Share the site with ten friends', apply: null })] }, facts);
    assert.deepEqual(g.recommendations.map((r) => r.apply), [null, null]);
  });
  it('drops a headline with an invented number but keeps the recommendations', () => {
    const g = groundAdvice({ headline: 'You will hit 900 visitors next month.', recommendations: [rec()] }, facts);
    assert.equal(g.headline, '');
    assert.equal(g.recommendations.length, 1);
  });
  it('keeps at most four, with unique ids', () => {
    const many = Array.from({ length: 7 }, (_, i) => rec({ id: 'same', title: `Try something different, number ${i}` }));
    const g = groundAdvice({ recommendations: many }, facts);
    assert.equal(g.recommendations.length, MAX_RECOMMENDATIONS);
    assert.equal(new Set(g.recommendations.map((r) => r.id)).size, MAX_RECOMMENDATIONS);
  });
  it('survives junk', () => {
    assert.deepEqual(groundAdvice(null, facts).recommendations, []);
    assert.deepEqual(groundAdvice({ recommendations: 'x' }, facts).recommendations, []);
    assert.deepEqual(groundAdvice({ recommendations: [null, 3, 'a', {}] }, facts).recommendations, []);
  });
  it('an empty list is a valid answer', () => {
    const g = groundAdvice({ headline: 'All quiet.', recommendations: [] }, facts);
    assert.deepEqual(g.recommendations, []);
    assert.equal(g.headline, 'All quiet.');
  });
});

describe('partnerPrompt', () => {
  it('contains the rules, the site and every fact — and no email addresses', () => {
    const facts = factsOf(okState());
    const p = partnerPrompt({
      name: 'Beanery', facts, manifest: null,
      plan: { schema: 1, name: 'Beanery', kind: 'site', one_liner: 'Small-batch coffee beans', audience: 'home brewers', offer: 'Beans by post', pricing: { model: 'one_time', items: [] }, pages: [{ file: 'index.html', title: 'Home', purpose: 'x' }], backend: { collections: [], products: ['Beans'], forms: ['bookings'], auth: false }, launch_checklist: [], scenario: null },
    });
    assert.ok(p.system.includes(PARTNER_MARK));
    assert.ok(p.system.includes('Small-batch coffee beans'));
    assert.ok(p.system.includes('Sells: Beans'));
    for (const f of facts) assert.ok(p.system.includes(`${f.id}: ${f.text}`), f.id);
    assert.doesNotMatch(p.system, /@/);
  });
});

// ── the handler ─────────────────────────────────────────────────────────────────────────────────────
const OWNER = 'user-owner';
const PROJECT: ProjectRow = { id: 'p1', user_id: OWNER, name: 'Beanery', published_version: 2 };
const GOOD_REPLY = JSON.stringify({
  headline: 'Visitors are up on last month.',
  recommendations: [
    { id: 'shop', title: 'Make the shop button easier to find', why: 'Lots of people reach the shop page but few buy.', cites: ['page.2', 'orders'], apply: 'Make the Shop button bigger on the home page.' },
    { id: 'invented', title: 'Aim for 1000 visitors', why: 'That would be great.', cites: ['visitors'], apply: null },
  ],
});

interface Calls { models: { system: string; user: string; max: number }[]; billed: { uid: string; i: number; o: number }[]; rate: string[]; gate: string[] }
function fake(over: Partial<Deps> & { state?: BusinessState | null; age?: number; row?: ProjectRow | null; reply?: string | Error; gate?: string | null; allowed?: boolean; members?: string[] } = {}): { deps: Deps; calls: Calls } {
  const calls: Calls = { models: [], billed: [], rate: [], gate: [] };
  const state = over.state === undefined ? okState() : over.state;
  const saved: SavedArtifact | null = state ? { version: 7, data: { ...state, computed_at: new Date(NOW.getTime() - (over.age ?? 60_000)).toISOString() }, created_at: NOW.toISOString() } : null;
  const deps: Deps = {
    now: () => NOW,
    userId: async (h) => (h === 'Bearer owner' ? OWNER : h === 'Bearer member' ? 'user-member' : h === 'Bearer stranger' ? 'user-x' : null),
    project: async (id) => (id === 'p1' ? (over.row === undefined ? PROJECT : over.row) : null),
    isMember: async (_p, u) => (over.members ?? ['user-member']).includes(u),
    latestArtifact: async (_p, kind) => (kind === 'business_state' ? saved : null),
    rateHit: async (key) => { calls.rate.push(key); return { allowed: over.allowed ?? true, retryAfter: 120 }; },
    usageGate: async (u) => { calls.gate.push(u); return over.gate ?? null; },
    callModel: async (system, user, max): Promise<ModelReply> => {
      calls.models.push({ system, user, max });
      const r = over.reply ?? GOOD_REPLY;
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 1500, outputTokens: 400 };
    },
    recordUsage: async (uid, i, o) => { calls.billed.push({ uid, i, o }); return 1; },
    ...over,
  };
  return { deps, calls };
}
const ask = (deps: Deps, auth: string | null = 'Bearer owner', body: unknown = { project_id: 'p1' }) =>
  handle(new Request('https://x/business-partner', { method: 'POST', headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), deps);

describe('business-partner handler', () => {
  it('answers with the recommendations the numbers back up, bills the call, drops the invented one', async () => {
    const { deps, calls } = fake();
    const res = await ask(deps);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.advice.recommendations.map((r: { id: string }) => r.id), ['shop']);
    assert.equal(out.advice.state_version, 7);
    assert.equal(out.advice.period_days, 30);
    assert.equal(out.advice.headline, 'Visitors are up on last month.');
    assert.equal(out.advice.recommendations[0].apply, 'Make the Shop button bigger on the home page.');
    assert.equal(calls.models.length, 1);
    assert.deepEqual(calls.billed, [{ uid: OWNER, i: 1500, o: 400 }]);
    assert.equal(out.cents, 1);
    assert.deepEqual(calls.rate, [`partner:${OWNER}`]);
  });
  it('the model is only given the facts, the site and a fixed question', async () => {
    const { deps, calls } = fake();
    await ask(deps);
    assert.ok(calls.models[0]!.system.includes('FACTS (id: statement)'));
    assert.ok(calls.models[0]!.system.includes('Name: Beanery'));
    assert.equal(calls.models[0]!.user, 'Here is how my business is doing. What should I do next?');
    assert.ok(calls.models[0]!.max <= 2000);
  });
  it('an accepted collaborator may ask', async () => {
    const { deps } = fake();
    assert.equal((await ask(deps, 'Bearer member')).status, 200);
  });
  it('401 without a verified user; 404 for a stranger and for a missing project (same answer)', async () => {
    const { deps } = fake();
    assert.equal((await ask(deps, null)).status, 401);
    assert.equal((await ask(deps, 'Bearer nonsense')).status, 401);
    const a = await ask(deps, 'Bearer stranger');
    const b = await ask(deps, 'Bearer owner', { project_id: 'nope' });
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.deepEqual(await a.json(), await b.json());
  });
  it('400 on a bad body', async () => {
    const { deps } = fake();
    assert.equal((await ask(deps, 'Bearer owner', '{nope')).status, 400);
    assert.equal((await ask(deps, 'Bearer owner', {})).status, 400);
    assert.equal((await ask(deps, 'Bearer owner', { project_id: 'x'.repeat(101) })).status, 400);
  });
  it('409 when the site is not live, there is no saved state, or the state is old — no model call', async () => {
    for (const [d, code] of [
      [fake({ row: { ...PROJECT, published_version: null } }), 'not_live'],
      [fake({ state: null }), 'no_state'],
      [fake({ age: STATE_MAX_AGE_MS + 60_000 }), 'state_old'],
    ] as const) {
      const res = await ask(d.deps);
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, code);
      assert.equal(d.calls.models.length, 0);
    }
  });
  it('says "not enough data" for a quiet or young site without calling a model or charging anything', async () => {
    for (const [state, level] of [[quietState(), 'none'], [earlyState(), 'early']] as const) {
      const { deps, calls } = fake({ state });
      const res = await ask(deps);
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.status, 'not_enough_data');
      assert.equal(out.level, level);
      assert.equal(out.message, NOT_ENOUGH[level]);
      assert.equal(calls.models.length, 0);
      assert.equal(calls.billed.length, 0);
      assert.equal(calls.rate.length, 0);
    }
  });
  it('402 when the owner is out of credits — no model call', async () => {
    const { deps, calls } = fake({ gate: 'You\'ve used all your AI credits for this month.' });
    const res = await ask(deps);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, 'usage_limit');
    assert.equal(calls.models.length, 0);
  });
  it('429 after too many asks in an hour — no model call', async () => {
    const { deps, calls } = fake({ allowed: false });
    const res = await ask(deps);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).retry_after, 120);
    assert.equal(calls.models.length, 0);
    assert.ok(ASKS_PER_HOUR >= 5);
  });
  it('never tells the owner about a provider account problem', async () => {
    const { deps } = fake({ reply: new ModelError('credit', '400 Your credit balance is too low') });
    const res = await ask(deps);
    assert.equal(res.status, 503);
    const text = JSON.stringify(await res.json());
    assert.doesNotMatch(text, /credit|balance|anthropic|key/i);
  });
  it('a busy provider is 503, anything else 502; neither bills', async () => {
    const a = fake({ reply: new ModelError('busy', '529') });
    assert.equal((await ask(a.deps)).status, 503);
    const b = fake({ reply: new ModelError('other', '400 bad') });
    assert.equal((await ask(b.deps)).status, 502);
    const c = fake({ reply: new Error('boom') });
    assert.equal((await ask(c.deps)).status, 502);
    for (const x of [a, b, c]) assert.equal(x.calls.billed.length, 0);
  });
  it('a reply that is not JSON gives an empty (honest) list and is still billed', async () => {
    const { deps, calls } = fake({ reply: 'I think you should try harder!' });
    const out = await (await ask(deps)).json();
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.advice.recommendations, []);
    assert.equal(calls.billed.length, 1);
  });
  it('OPTIONS answers CORS; other methods are refused', async () => {
    const { deps } = fake();
    assert.equal((await handle(new Request('https://x', { method: 'OPTIONS' }), deps)).status, 200);
    assert.equal((await handle(new Request('https://x', { method: 'GET' }), deps)).status, 405);
  });
});

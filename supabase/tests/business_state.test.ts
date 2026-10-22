// BUSINESS data layer — run:  node --test supabase/tests/business_state.test.ts
// The pure builder (_shared/business.ts) and the business-state handler against an in-memory fake. The SQL side is
// supabase/tests/step13_business_stats.sql.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateArtifact, type BusinessState } from '../functions/_shared/artifacts.ts';
import { buildBusinessState, dataLevel, formatMoney, tidySources, versusPlan, type RawStats } from '../functions/_shared/business.ts';
import { FRESH_MS, handle, type Deps, type ProjectRow, type SavedArtifact } from '../functions/business-state/handler.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const DAYS = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAYS);

const day = (i: number, views = 0, visitors = 0) => ({ day: `2026-10-${18 + i}`, views, visitors });
/** A busy, healthy month: 120 visitors (up from 80), 6 orders, refunds, 4 sign-ups, 3 form entries. */
function busy(): RawStats {
  return {
    days: 30,
    traffic: {
      views: 400, visitors: 120, sessions: 150, prev_views: 250, prev_visitors: 80,
      pages: [{ page: '/', views: 250, visitors: 110 }, { page: '/shop.html', views: 100, visitors: 50 }],
      sources: [{ source: '', visitors: 40 }, { source: 'www.google.com', visitors: 30 }, { source: 'google.co.uk', visitors: 10 }, { source: 'l.facebook.com', visitors: 20 }, { source: 'liam.vexium.ai', visitors: 15 }],
      devices: [{ device: 'mobile', visitors: 90 }, { device: 'desktop', visitors: 30 }],
      daily: [day(0, 10, 5), day(1, 0, 0)],
    },
    money: {
      current: [
        { currency: 'usd', orders: 5, gross_cents: 12500, refunds_cents: -2500, net_cents: 10000 },
        { currency: 'gbp', orders: 1, gross_cents: 500, refunds_cents: 0, net_cents: 500 },
      ],
      previous: [{ currency: 'usd', orders: 4, gross_cents: 8000, refunds_cents: 0, net_cents: 8000 }],
      products: [
        { name: 'Beans', currency: 'usd', units: 4, cents: 10000 },
        { name: 'Mug', currency: 'usd', units: 1, cents: 2500 },
        { name: 'Cake', currency: 'gbp', units: 1, cents: 500 },
      ],
    },
    signups: { current: 4, previous: 2 },
    leads: { current: 3, previous: 3, by_collection: [{ collection: 'bookings', count: 2 }, { collection: 'contact', count: 1 }] },
    lifetime: { views: 900, first_view_at: '2026-09-01T00:00:00Z', orders: 12, signups: 9, leads: 8 },
    recent: [{ type: 'sale', at: '2026-10-23T10:00:00Z', what: 'Beans', cents: 2500, currency: 'usd' }, { type: 'bogus', at: 'x' }, { type: 'signup', at: '2026-10-22T10:00:00Z' }],
  };
}

describe('buildBusinessState', () => {
  const s = buildBusinessState({ stats: busy(), now: NOW, firstLiveAt: ago(40), sells: true, ownHosts: ['liam.vexium.ai'] });

  it('copies the counts and passes the artifact validator', () => {
    assert.equal(s.visitors, 120);
    assert.equal(s.views, 400);
    assert.equal(s.signups, 4);
    assert.equal(s.leads, 3);
    assert.equal(s.period_days, 30);
    assert.equal(s.computed_at, NOW.toISOString());
    const v = validateArtifact('business_state', s);
    assert.ok(v.ok, JSON.stringify(v));
  });
  it('orders count every currency; revenue is the main currency only, net of refunds', () => {
    assert.equal(s.orders, 6);
    assert.equal(s.currency, 'usd');
    assert.equal(s.revenue_cents, 10000);
    assert.deepEqual(s.other_currencies, [{ currency: 'gbp', orders: 1, net_cents: 500 }]);
    assert.ok(s.notes?.some((n) => /other currencies/.test(n)));
  });
  it('products are the main currency only', () => {
    assert.deepEqual(s.products?.map((p) => p.name), ['Beans', 'Mug']);
  });
  it('percent changes vs the previous period', () => {
    assert.equal(s.changes?.visitors, 50);
    assert.equal(s.changes?.revenue, 25);
    assert.equal(s.changes?.leads, 0);
    assert.equal(s.previous?.orders, 4);
  });
  it('conversion = (orders + leads + sign-ups) / visitors, one decimal', () => {
    assert.equal(s.conversion_rate, 10.8); // 13 / 120
  });
  it('sources are grouped and tidied; the site\'s own host is dropped', () => {
    assert.deepEqual(s.sources, [{ source: 'Google', visitors: 40 }, { source: 'Direct', visitors: 40 }, { source: 'Facebook', visitors: 20 }].sort((a, b) => b.visitors - a.visitors || a.source.localeCompare(b.source)));
    assert.ok(!s.sources?.some((x) => /vexium/.test(x.source)));
  });
  it('recent keeps only known event types', () => {
    assert.deepEqual(s.recent?.map((r) => r.type), ['sale', 'signup']);
    assert.equal(s.recent?.[0].cents, 2500);
  });
  it('is "ok" with 120 visitors and 40 days live', () => {
    assert.equal(s.data_level, 'ok');
    assert.equal(s.live_days, 40);
    assert.ok(!s.notes?.some((n) => /Too early/.test(n)));
  });
  it('insights state facts from the numbers only', () => {
    const ids = s.insights!.map((i) => i.id);
    for (const id of ['orders', 'top_product', 'refunds', 'leads', 'signups', 'visitors_up', 'mostly_mobile', 'conversion']) assert.ok(ids.includes(id), `missing ${id}: ${ids}`);
    assert.match(s.insights!.find((i) => i.id === 'orders')!.text, /6 orders .* \$100\.00 after refunds/);
    assert.match(s.insights!.find((i) => i.id === 'visitors_up')!.text, /up 50%/);
    assert.match(s.insights!.find((i) => i.id === 'mostly_mobile')!.text, /75%/);
    assert.ok(s.insights!.length <= 8);
  });
});

describe('early and empty sites never overclaim', () => {
  it('a brand-new site with nothing recorded says so and nothing else', () => {
    const s = buildBusinessState({ stats: {}, now: NOW, firstLiveAt: ago(0) });
    assert.equal(s.data_level, 'none');
    assert.equal(s.visitors, 0);
    assert.equal(s.conversion_rate, null);
    assert.equal(s.changes?.visitors, null);
    assert.equal(s.vs_plan, null);
    assert.deepEqual(s.insights?.map((i) => i.id), ['no_visits']);
    assert.match(s.insights![0].text, /just went live/);
    assert.ok(validateArtifact('business_state', s).ok);
  });
  it('a day-old site with no visits suggests sharing the address', () => {
    const s = buildBusinessState({ stats: {}, now: NOW, firstLiveAt: ago(2) });
    assert.match(s.insights![0].text, /Nobody has visited yet/);
  });
  it('a week-old site with 8 visitors is "early": no trends, no conversion rate, a caveat', () => {
    const stats: RawStats = {
      days: 30, traffic: { views: 12, visitors: 8, prev_views: 0, prev_visitors: 0 },
      money: { current: [{ currency: 'usd', orders: 1, gross_cents: 2000, refunds_cents: 0, net_cents: 2000 }] },
      lifetime: { views: 12, orders: 1, signups: 0, leads: 0 },
    };
    const s = buildBusinessState({ stats, now: NOW, firstLiveAt: ago(8), sells: true });
    assert.equal(s.data_level, 'early');
    assert.equal(s.conversion_rate, null);
    assert.equal(s.changes?.visitors, null);
    assert.ok(s.notes?.some((n) => /Too early/.test(n)));
    const ids = s.insights!.map((i) => i.id);
    assert.ok(ids.includes('orders') && ids.includes('early'));
    assert.ok(!ids.includes('visitors_up') && !ids.includes('conversion') && !ids.includes('top_source') && !ids.includes('no_orders'));
  });
  it('plenty of visitors but a shop with no orders is flagged, a non-shop is not', () => {
    const stats: RawStats = { days: 30, traffic: { views: 300, visitors: 150, prev_visitors: 0 }, lifetime: { views: 300, orders: 0, signups: 0, leads: 0 } };
    const shop = buildBusinessState({ stats, now: NOW, firstLiveAt: ago(30), sells: true });
    assert.ok(shop.insights!.some((i) => i.id === 'no_orders' && i.tone === 'watch'));
    const notShop = buildBusinessState({ stats, now: NOW, firstLiveAt: ago(30), sells: false });
    assert.ok(!notShop.insights!.some((i) => i.id === 'no_orders'));
  });
  it('garbage numbers become zeros, never NaN', () => {
    const s = buildBusinessState({ stats: { traffic: { views: NaN as unknown as number, visitors: -4 } }, now: NOW, firstLiveAt: null });
    assert.equal(s.views, 0);
    assert.equal(s.visitors, 0);
    assert.equal(s.live_days, null);
    assert.ok(validateArtifact('business_state', s).ok);
  });
  it('a failed-only month (refunds bigger than sales) never shows negative revenue', () => {
    const stats: RawStats = { days: 30, traffic: { visitors: 60, views: 80 }, money: { current: [{ currency: 'usd', orders: 0, gross_cents: 0, refunds_cents: -3000, net_cents: -3000 }] }, lifetime: { views: 80, orders: 1, signups: 0, leads: 0 } };
    assert.equal(buildBusinessState({ stats, now: NOW, firstLiveAt: ago(20) }).revenue_cents, 0);
  });
});

describe('helpers', () => {
  it('dataLevel', () => {
    const none = { views: 0, orders: 0, signups: 0, leads: 0 };
    assert.equal(dataLevel(0, 10, none), 'none');
    assert.equal(dataLevel(49, 30, { ...none, views: 49 }), 'early');
    assert.equal(dataLevel(50, 6, { ...none, views: 50 }), 'early');
    assert.equal(dataLevel(50, 7, { ...none, views: 50 }), 'ok');
    assert.equal(dataLevel(500, null, { ...none, views: 500 }), 'early');
  });
  it('tidySources merges, labels and drops own hosts', () => {
    const out = tidySources([{ source: '', visitors: 3 }, { source: 'DIRECT.example', visitors: 1 }, { source: 'www.mysite.com', visitors: 9 }, { source: 't.co', visitors: 2 }, { source: 'x.com', visitors: 1 }], ['mysite.com']);
    assert.deepEqual(out, [{ source: 'Direct', visitors: 3 }, { source: 'X', visitors: 3 }, { source: 'direct.example', visitors: 1 }].sort((a, b) => b.visitors - a.visitors || a.source.localeCompare(b.source)));
  });
  it('formatMoney', () => {
    assert.equal(formatMoney(2500, 'usd'), '$25.00');
    assert.equal(formatMoney(500, 'gbp'), '£5.00');
    assert.match(formatMoney(500, 'zzzz'), /5\.00 ZZZZ/);
  });
  it('versusPlan scales to 30 days and waits a week', () => {
    const scenario = { price_cents: 2000, monthly_visitors: 1000, conversion_pct: 2 };
    assert.equal(versusPlan(scenario, { visitors: 50, orders: 1, leads: 0, signups: 0, revenue_cents: 2000, window_days: 6 }), null);
    assert.equal(versusPlan(null, { visitors: 50, orders: 1, leads: 0, signups: 0, revenue_cents: 2000, window_days: 30 }), null);
    const v = versusPlan(scenario, { visitors: 100, orders: 3, leads: 0, signups: 0, revenue_cents: 6000, window_days: 15 })!;
    assert.deepEqual(v.planned, { monthly_visitors: 1000, conversion_pct: 2, price_cents: 2000, monthly_revenue_cents: 40000 });
    assert.deepEqual(v.actual, { monthly_visitors: 200, conversion_pct: 3, avg_order_cents: 2000, monthly_revenue_cents: 12000 });
    const few = versusPlan(scenario, { visitors: 20, orders: 0, leads: 0, signups: 0, revenue_cents: 0, window_days: 30 })!;
    assert.equal(few.actual.conversion_pct, null);
    assert.equal(few.actual.avg_order_cents, null);
  });
  it('the plan scenario shows up in the state once a week of data exists', () => {
    const s = buildBusinessState({ stats: busy(), now: NOW, firstLiveAt: ago(40), scenario: { price_cents: 2000, monthly_visitors: 100, conversion_pct: 5 } });
    assert.equal(s.vs_plan?.planned.monthly_revenue_cents, 10000);
    assert.equal(s.vs_plan?.actual.monthly_visitors, 120);
  });
  it('a site live for only 3 days is compared over 4 days, not 30', () => {
    const stats: RawStats = { days: 30, traffic: { visitors: 40, views: 50 }, lifetime: { views: 50, orders: 0, signups: 0, leads: 0 } };
    const s = buildBusinessState({ stats, now: NOW, firstLiveAt: ago(3), scenario: { price_cents: 1, monthly_visitors: 1, conversion_pct: 1 } });
    assert.equal(s.vs_plan, null); // < a week
  });
});

// ── handler ────────────────────────────────────────────────────────────────────────────────────────
const OWNER = 'u-owner', MEMBER = 'u-member', STRANGER = 'u-stranger';
function fake(over: Partial<ProjectRow> = {}, opts: { saved?: SavedArtifact | null; plan?: SavedArtifact | null } = {}) {
  const calls = { stats: 0, saved: [] as BusinessState[], statsArgs: [] as unknown[] };
  const project: ProjectRow = { id: 'p1', user_id: OWNER, published_version: 2, published_slug: 'cafe', custom_domain: 'www.cafe.test', ...over };
  let savedArtifact = opts.saved ?? null;
  const deps: Deps = {
    now: () => NOW,
    userId: async (h) => (h === 'Bearer owner' ? OWNER : h === 'Bearer member' ? MEMBER : h === 'Bearer stranger' ? STRANGER : null),
    project: async (id) => (id === 'p1' ? project : null),
    isMember: async (_p, u) => u === MEMBER,
    username: async () => 'liam',
    firstLiveAt: async () => ago(40),
    latestArtifact: async (_p, kind) => (kind === 'plan' ? (opts.plan ?? null) : savedArtifact),
    stats: async (p, d, now) => { calls.stats++; calls.statsArgs.push([p, d, now.toISOString()]); return busy(); },
    saveState: async (_p, st) => { calls.saved.push(st); savedArtifact = { version: 7 + calls.saved.length, data: st as unknown as Record<string, unknown>, created_at: NOW.toISOString() }; return { version: savedArtifact.version }; },
  };
  return { deps, calls };
}
const post = (body: unknown, auth: string | null = 'Bearer owner') =>
  new Request('https://x.test/business-state', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('business-state handler', () => {
  it('rejects the signed-out and bad tokens with 401', async () => {
    const { deps, calls } = fake();
    assert.equal((await handle(post({ project_id: 'p1' }, null), deps)).status, 401);
    assert.equal((await handle(post({ project_id: 'p1' }, 'Bearer forged'), deps)).status, 401);
    assert.equal(calls.stats, 0);
  });
  it('answers 404 to a stranger and to a missing project alike', async () => {
    const { deps, calls } = fake();
    const a = await handle(post({ project_id: 'p1' }, 'Bearer stranger'), deps);
    const b = await handle(post({ project_id: 'nope' }), deps);
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(calls.stats, 0);
  });
  it('409 not_live for a project that was never published', async () => {
    const { deps } = fake({ published_version: null });
    const r = await handle(post({ project_id: 'p1' }), deps);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'not_live');
  });
  it('validates the body', async () => {
    const { deps } = fake();
    assert.equal((await handle(post('not json'), deps)).status, 400);
    assert.equal((await handle(post({}), deps)).status, 400);
    assert.equal((await handle(post({ project_id: 'p1', days: 14 }), deps)).status, 400);
    assert.equal((await handle(post({ project_id: 'p1', days: '30' }), deps)).status, 400);
    assert.equal((await handle(new Request('https://x.test/', { method: 'GET' }), deps)).status, 405);
    assert.equal((await handle(new Request('https://x.test/', { method: 'OPTIONS' }), deps)).status, 200);
  });
  it('the owner gets a computed, saved, valid state (30 days by default)', async () => {
    const { deps, calls } = fake({}, { plan: { version: 1, created_at: '', data: { scenario: { price_cents: 2000, monthly_visitors: 100, conversion_pct: 5 }, backend: { products: ['beans'] } } } });
    const r = await handle(post({ project_id: 'p1' }), deps);
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.cached, false);
    assert.equal(out.state.period_days, 30);
    assert.equal(out.state.visitors, 120);
    assert.equal(out.version, 8);
    assert.deepEqual(calls.statsArgs[0], ['p1', 30, NOW.toISOString()]);
    assert.equal(calls.saved.length, 1);
    assert.ok(out.state.vs_plan, 'the plan scenario is read');
    assert.ok(out.state.insights.some((i: { id: string }) => i.id === 'top_product'), 'a plan with products makes it a shop');
    // the site's own addresses are not sources (liam.vexium.ai came from `username`)
    assert.ok(!out.state.sources.some((x: { source: string }) => /vexium/.test(x.source)));
  });
  it('an accepted member may read it too', async () => {
    const { deps } = fake();
    assert.equal((await handle(post({ project_id: 'p1' }, 'Bearer member'), deps)).status, 200);
  });
  it('a fresh saved state is returned without recomputing; refresh, another period or an old state recompute', async () => {
    const { deps, calls } = fake();
    await handle(post({ project_id: 'p1' }), deps);
    assert.equal(calls.stats, 1);
    const again = await (await handle(post({ project_id: 'p1' }), deps)).json();
    assert.equal(again.cached, true);
    assert.equal(calls.stats, 1);
    assert.equal((await (await handle(post({ project_id: 'p1', refresh: true }), deps)).json()).cached, false);
    assert.equal(calls.stats, 2);
    assert.equal((await (await handle(post({ project_id: 'p1', days: 7 }), deps)).json()).state.period_days, 30); // stats fake always says 30
    assert.equal(calls.stats, 3);
    const old = fake({}, { saved: { version: 3, created_at: '', data: { computed_at: new Date(NOW.getTime() - FRESH_MS - 1).toISOString(), period_days: 30 } } });
    assert.equal((await (await handle(post({ project_id: 'p1' }), old.deps)).json()).cached, false);
  });
});

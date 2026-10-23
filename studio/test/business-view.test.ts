import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHART_H, CHART_W, activityLines, barPath, businessErrorText, changeOf, dailyChart, dataBanner, dayLabel, deviceRows, extraNotes, formatCount,
  money, niceTop, pageRows, planRows, productRows, readBusinessState, sourceRows, statCards,
} from '../src/lib/business-view.ts';
import type { BusinessState } from '../src/types/artifacts.ts';

const state = (over: Partial<BusinessState> = {}): BusinessState => ({
  schema: 1, computed_at: '2026-10-22T12:00:00Z', period_days: 30, visitors: 120, signups: 0, orders: 0, revenue_cents: 0, data_level: 'ok', ...over,
});

describe('reading the server answer', () => {
  it('accepts a valid state and drops list entries a screen cannot draw', () => {
    const s = readBusinessState({
      ...state({ views: 300 }),
      pages: [{ page: '/', views: 10, visitors: 5 }, { page: 7, views: 1 }, null, { page: '/about' }],
      sources: [{ source: 'Google', visitors: 4 }, { source: '', visitors: 1 }],
      recent: [{ type: 'sale', at: '2026-10-22T11:00:00Z', cents: 500 }, { type: 'bogus', at: 'x' }, { type: 'lead' }],
      insights: [{ id: 'a', tone: 'good', text: 'ok' }, { id: 'b', tone: 'loud', text: 'no' }],
      notes: ['one'],
    });
    assert.ok(s);
    assert.deepEqual(s!.pages, [{ page: '/', views: 10, visitors: 5 }]);
    assert.deepEqual(s!.sources, [{ source: 'Google', visitors: 4 }]);
    assert.equal(s!.recent!.length, 1);
    assert.equal(s!.insights!.length, 1);
    assert.deepEqual(s!.notes, ['one']);
  });

  it('refuses anything that is not a business state', () => {
    assert.equal(readBusinessState(null), null);
    assert.equal(readBusinessState('nope'), null);
    assert.equal(readBusinessState({ schema: 1, visitors: 'many' }), null);
    assert.equal(readBusinessState({ ...state(), schema: 2 }), null);
  });
});

describe('numbers', () => {
  it('formats counts and money', () => {
    assert.equal(formatCount(1234567), '1,234,567');
    assert.equal(money(1250), '$12.50');
    assert.equal(money(0), '$0.00');
    assert.equal(money(999, 'eur'), '€9.99');
    assert.equal(money(100, 'not-a-currency'), '1.00 NOT-A-CURRENCY');
  });

  it('shows a change only when the server sent a number', () => {
    assert.equal(changeOf(null, 30), null);
    assert.equal(changeOf(undefined, 30), null);
    assert.equal(changeOf(Number.NaN, 30), null);
    assert.deepEqual(changeOf(25, 30), { pct: 25, direction: 'up', text: '▲ 25%', label: 'Up 25% on the 30 days before' });
    assert.equal(changeOf(-10, 7)!.text, '▼ 10%');
    assert.equal(changeOf(-10, 7)!.label, 'Down 10% on the 7 days before');
    assert.equal(changeOf(0, 7)!.direction, 'flat');
    assert.equal(changeOf(12.6, 30)!.text, '▲ 13%');
  });
});

describe('headline cards', () => {
  it('shows visitors alone for a plain site with nothing else yet', () => {
    const cards = statCards(state(), { sells: false });
    assert.deepEqual(cards.map((c) => c.id), ['visitors']);
    assert.equal(cards[0]!.value, '120');
    assert.equal(cards[0]!.change, null);
  });

  it('adds money cards for a shop, even before the first sale', () => {
    const cards = statCards(state(), { sells: true });
    assert.deepEqual(cards.map((c) => c.id), ['visitors', 'revenue', 'orders']);
    assert.equal(cards[1]!.value, '$0.00');
  });

  it('adds money cards when sales exist although the plan has no products', () => {
    assert.deepEqual(statCards(state({ orders: 2, revenue_cents: 4000 }), { sells: false }).map((c) => c.id), ['visitors', 'revenue', 'orders']);
  });

  it('adds sign-ups and form entries once there has been one (this period or ever)', () => {
    const ids = (s: BusinessState) => statCards(s, { sells: false }).map((c) => c.id);
    assert.deepEqual(ids(state({ signups: 3 })), ['visitors', 'signups']);
    assert.deepEqual(ids(state({ leads: 1 })), ['visitors', 'leads']);
    assert.deepEqual(ids(state({ lifetime: { views: 0, orders: 0, signups: 5, leads: 2 } })), ['visitors', 'signups', 'leads']);
  });

  it('carries arrows from the server, never computes them', () => {
    const withArrows = statCards(state({ changes: { visitors: 40, views: null, signups: null, orders: null, leads: null, revenue: null } }), { sells: true });
    assert.equal(withArrows[0]!.change!.direction, 'up');
    assert.equal(withArrows[1]!.change, null); // revenue: null from the server → no arrow
    const noArrows = statCards(state({ previous: { visitors: 10, views: 10, signups: 0, orders: 0, leads: 0, revenue_cents: 0 } }), { sells: false });
    assert.equal(noArrows[0]!.change, null); // a `previous` block alone is not a reason to invent a percentage
  });

  it('mentions conversion only when the server computed it', () => {
    assert.equal(statCards(state({ orders: 1, conversion_rate: 2.5 }), { sells: true })[2]!.hint, '2.5% of visitors');
    assert.equal(statCards(state({ orders: 1 }), { sells: true })[2]!.hint, null);
  });
});

describe('the not-enough-data banner', () => {
  it('says so for none and early, and stays quiet for ok', () => {
    assert.equal(dataBanner(state({ data_level: 'none' }))!.title, 'Waiting for your first visitor');
    assert.equal(dataBanner(state({ data_level: 'early' }))!.title, 'Early days');
    assert.equal(dataBanner(state({ data_level: 'ok' })), null);
    assert.equal(dataBanner(state({ data_level: undefined })), null);
  });

  it('drops the server notes the banner already says, keeps the rest', () => {
    const notes = ['Nothing has been recorded yet.', 'Too early to read much into these numbers — x', 'Visits you make yourself are counted too.'];
    assert.deepEqual(extraNotes(state({ data_level: 'none', notes })), ['Visits you make yourself are counted too.']);
    assert.deepEqual(extraNotes(state({ data_level: 'ok', notes })), notes);
    assert.deepEqual(extraNotes(state({ data_level: 'ok' })), []);
  });
});

describe('the daily chart', () => {
  const days = (counts: number[]) => counts.map((v, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, visitors: v }));

  it('has no chart when nobody visited', () => {
    assert.equal(dailyChart(undefined), null);
    assert.equal(dailyChart([]), null);
    assert.equal(dailyChart(days([0, 0, 0])), null);
  });

  it('picks a round top and draws zero days as nothing', () => {
    assert.equal(niceTop(0), 4);
    assert.equal(niceTop(3), 4);
    assert.equal(niceTop(7), 10);
    assert.equal(niceTop(11), 20);
    assert.equal(niceTop(34), 50);
    assert.equal(niceTop(101), 200);
    assert.equal(niceTop(5000), 5000);
    const c = dailyChart(days([0, 12, 3]))!;
    assert.equal(c.top, 20);
    assert.equal(c.bars[0]!.path, '');
    assert.notEqual(c.bars[1]!.path, '');
    assert.deepEqual(c.peak, { day: '2026-10-02', value: 12 });
    assert.equal(c.first, 'Oct 1');
    assert.equal(c.last, 'Oct 3');
  });

  it('keeps every bar inside its slot, thin, and never wider than 24', () => {
    const few = dailyChart(days([5, 6]))!;
    for (const b of few.bars) {
      const xs = [...b.path.matchAll(/[MH](\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
      assert.ok(Math.max(...xs) - Math.min(...xs) <= 24 + 0.2, 'bar at most 24 wide');
    }
    const many = dailyChart(days(Array.from({ length: 90 }, (_, i) => i % 7)))!;
    assert.equal(many.bars.length, 90);
    assert.ok(many.bars.every((b) => b.slotX >= 0 && b.slotX + b.slotW <= CHART_W + 0.5));
  });

  it('labels each bar for hover, focus and screen readers', () => {
    const c = dailyChart(days([1, 2]))!;
    assert.equal(c.bars[0]!.label, 'Oct 1 — 1 visitor');
    assert.equal(c.bars[1]!.label, 'Oct 2 — 2 visitors');
  });

  it('rounds the top of a column and keeps the bottom square', () => {
    const d = barPath(10, 20, 50, CHART_H);
    assert.ok(d.startsWith(`M10 ${CHART_H}V`), 'starts on the baseline');
    assert.ok(d.includes('Q'), 'has rounded corners at the top');
    assert.ok(d.endsWith(`V${CHART_H}Z`));
    assert.equal(barPath(0, 0, 10, CHART_H), '');
    assert.equal(barPath(0, 5, 0, CHART_H), '');
  });

  it('reads a day label in UTC, so no timezone moves it', () => {
    assert.equal(dayLabel('2026-10-14'), 'Oct 14');
    assert.equal(dayLabel('2026-01-01T00:00:00+00:00'), 'Jan 1');
    assert.equal(dayLabel('garbage'), 'garbage');
  });
});

describe('lists', () => {
  it('shares the biggest row as the full bar and keeps a sliver for small ones', () => {
    const rows = sourceRows(state({ visitors: 100, sources: [{ source: 'Google', visitors: 60 }, { source: 'Direct', visitors: 30 }, { source: 'X', visitors: 1 }] }));
    assert.deepEqual(rows.map((r) => r.width), [100, 50, 2]);
    assert.equal(rows[0]!.note, '60%');
  });

  it('caps a source share at 100% and tolerates zero visitors', () => {
    assert.equal(sourceRows(state({ visitors: 5, sources: [{ source: 'A', visitors: 9 }] }))[0]!.note, '100%');
    assert.equal(sourceRows(state({ visitors: 0, sources: [{ source: 'A', visitors: 0 }] }))[0]!.note, null);
  });

  it('formats pages, devices and products', () => {
    assert.equal(pageRows(state({ pages: [{ page: '/menu', views: 1200, visitors: 1 }] }))[0]!.value, '1,200');
    assert.equal(pageRows(state({ pages: [{ page: '/menu', views: 1200, visitors: 1 }] }))[0]!.note, '1 visitor');
    assert.deepEqual(deviceRows(state({ devices: [{ device: 'mobile', visitors: 4 }, { device: 'desktop', visitors: 2 }, { device: 'tv', visitors: 1 }] })).map((r) => r.name), ['Phone', 'Computer', 'Tv']);
    const p = productRows(state({ currency: 'usd', products: [{ name: 'Beans', units: 3, cents: 4500 }] }))[0]!;
    assert.equal(p.value, '$45.00');
    assert.equal(p.note, '3 sold');
    assert.deepEqual(productRows(state()), []);
  });
});

describe('recent activity', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  it('describes sales, sign-ups and form entries without any personal detail', () => {
    const lines = activityLines(state({
      recent: [
        { type: 'sale', at: '2026-10-22T11:00:00Z', what: 'Beans', cents: 1800, currency: 'usd' },
        { type: 'signup', at: '2026-10-22T10:00:00Z' },
        { type: 'lead', at: '2026-10-21T12:00:00Z', what: 'contact' },
      ],
    }), now);
    assert.deepEqual(lines.map((l) => l.text), ['Sale — Beans · $18.00', 'New sign-up', 'Form entry — contact']);
    assert.deepEqual(lines.map((l) => l.when), ['1 h ago', '2 h ago', '1 d ago']);
  });

  it('shows at most eight', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({ type: 'signup' as const, at: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
    assert.equal(activityLines(state({ recent }), now).length, 8);
  });
});

describe('plan vs. what happened', () => {
  const vs = {
    planned: { monthly_visitors: 1000, conversion_pct: 2, price_cents: 3000, monthly_revenue_cents: 60000 },
    actual: { monthly_visitors: 1300, conversion_pct: 1, avg_order_cents: null, monthly_revenue_cents: 61000 },
  };

  it('has no rows without a scenario', () => {
    assert.deepEqual(planRows(null), []);
    assert.deepEqual(planRows(undefined), []);
  });

  it('judges each line against the plan, and says nothing when there is nothing to compare', () => {
    const rows = planRows(vs);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by.visitors!.verdict, 'ahead');
    assert.equal(by.conversion!.verdict, 'behind');
    assert.equal(by.order!.verdict, null);
    assert.equal(by.order!.actual, '—');
    assert.equal(by.revenue!.verdict, 'on-track');
    assert.equal(by.revenue!.planned, '$600.00');
    assert.equal(by.conversion!.planned, '2%');
  });
});

describe('error wording', () => {
  it('speaks plainly for the known failures', () => {
    assert.match(businessErrorText(Object.assign(new Error('x'), { status: 409 })), /isn’t live yet/);
    assert.match(businessErrorText(Object.assign(new Error('x'), { status: 404 })), /couldn’t find/);
    assert.match(businessErrorText(Object.assign(new Error('x'), { status: 401 })), /sign in again/);
    assert.match(businessErrorText(new TypeError('Failed to fetch')), /Couldn’t reach the server/);
    assert.equal(businessErrorText(new Error('Boom')), 'Boom');
    assert.match(businessErrorText(new Error('')), /Something went wrong/);
  });
});

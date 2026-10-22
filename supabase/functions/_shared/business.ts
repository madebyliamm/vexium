// BUSINESS (Step 13): turn the raw counts from the SQL function vx_business_stats() into the `business_state` artifact.
// Pure TypeScript, no imports from the platform (runs in the business-state edge function, the studio and Node tests).
//
// Rules this file keeps:
//   * every number is a count of rows that exist — nothing is guessed, projected or rounded up;
//   * a percentage change or a conversion rate is `null` until the numbers behind it are big enough to mean something;
//   * `insights` are plain observations of the numbers (the AI partner in chunk C is grounded in this state and may not say more).
import type { BusinessInsight, BusinessState, BusinessVsPlan, DataLevel, RevenueScenario } from './artifacts.ts';

/** The jsonb vx_business_stats() returns (see supabase/migrations/20261024100000_business_stats.sql). Everything may be missing. */
export interface RawStats {
  days?: number;
  traffic?: {
    views?: number; visitors?: number; sessions?: number; prev_views?: number; prev_visitors?: number;
    pages?: { page: string; views: number; visitors: number }[];
    sources?: { source: string; visitors: number }[];
    devices?: { device: string; visitors: number }[];
    daily?: { day: string; views: number; visitors: number }[];
  };
  money?: {
    current?: MoneyRow[];
    previous?: MoneyRow[];
    products?: { name: string; currency: string; units: number; cents: number }[];
  };
  signups?: { current?: number; previous?: number };
  leads?: { current?: number; previous?: number; by_collection?: { collection: string; count: number }[] };
  lifetime?: { views?: number; first_view_at?: string | null; orders?: number; signups?: number; leads?: number };
  recent?: { type: string; at: string; what?: string; cents?: number; currency?: string }[];
}
interface MoneyRow { currency: string; orders: number; gross_cents: number; refunds_cents: number; net_cents: number }

export interface BuildInput {
  stats: RawStats;
  now: Date;
  /** When the first deploy went live (project_deploys), or null. */
  firstLiveAt: Date | null;
  /** The plan's revenue scenario, if it has one. */
  scenario?: RevenueScenario | null;
  /** True when the site sells things (manifest/plan products > 0). */
  sells?: boolean;
  /** Hosts that are this site itself (`name.vexium.ai`, the custom domain): visits that came from one's own pages are not a "source". */
  ownHosts?: string[];
}

/** Enough to read the numbers: this many visitors AND a week live. Below that the screen says "early". */
export const ENOUGH_VISITORS = 50;
export const ENOUGH_DAYS = 7;
/** A % change is only reported when the earlier period had at least this many (traffic) / (events). */
const MIN_PREV_TRAFFIC = 20;
const MIN_PREV_EVENTS = 3;

const DAY = 86_400_000;
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const int = (v: unknown): number => Math.max(0, Math.round(n(v)));
const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);

function change(cur: number, prev: number, min: number): number | null {
  if (prev < min) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** "$25.00" / "£5.00"; an unknown currency code falls back to the code itself. */
export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const SOURCE_LABELS: [RegExp, string][] = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)(facebook|fb)\.com$|(^|\.)fb\.me$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(twitter|x)\.com$|^t\.co$/, 'X'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'LinkedIn'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)pinterest\./, 'Pinterest'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
];

/** Group raw referrer hosts into readable sources: "" → Direct, google.* → Google …; the site's own hosts are dropped. */
export function tidySources(rows: { source: string; visitors: number }[], ownHosts: string[] = []): { source: string; visitors: number }[] {
  const own = new Set(ownHosts.map((h) => h.toLowerCase().replace(/^www\./, '')));
  const sum = new Map<string, number>();
  for (const r of rows) {
    const raw = String(r.source ?? '').toLowerCase().trim();
    const host = raw.replace(/^www\./, '');
    if (host && own.has(host)) continue;
    const label = !host ? 'Direct' : (SOURCE_LABELS.find(([re]) => re.test(host))?.[1] ?? host);
    sum.set(label, (sum.get(label) ?? 0) + int(r.visitors));
  }
  return [...sum.entries()].map(([source, visitors]) => ({ source, visitors })).sort((a, b) => b.visitors - a.visitors || a.source.localeCompare(b.source)).slice(0, 8);
}

export function dataLevel(visitors: number, liveDays: number | null, lifetime: { views: number; orders: number; signups: number; leads: number }): DataLevel {
  if (lifetime.views + lifetime.orders + lifetime.signups + lifetime.leads === 0) return 'none';
  return visitors >= ENOUGH_VISITORS && (liveDays ?? 0) >= ENOUGH_DAYS ? 'ok' : 'early';
}

/** The plan's scenario beside what really happened, everything scaled to 30 days. Null before a week of data or without a scenario. */
export function versusPlan(scenario: RevenueScenario | null | undefined, a: { visitors: number; orders: number; leads: number; signups: number; revenue_cents: number; window_days: number }): BusinessVsPlan | null {
  if (!scenario || a.window_days < ENOUGH_DAYS) return null;
  const scale = 30 / a.window_days;
  const monthlyVisitors = Math.round(a.visitors * scale);
  const monthlyRevenue = Math.round(a.revenue_cents * scale);
  return {
    planned: {
      monthly_visitors: int(scenario.monthly_visitors),
      conversion_pct: n(scenario.conversion_pct),
      price_cents: int(scenario.price_cents),
      monthly_revenue_cents: Math.round(n(scenario.monthly_visitors) * (n(scenario.conversion_pct) / 100) * n(scenario.price_cents)),
    },
    actual: {
      monthly_visitors: monthlyVisitors,
      conversion_pct: a.visitors >= ENOUGH_VISITORS ? Math.min(100, Math.round(((a.orders / a.visitors) * 100) * 10) / 10) : null,
      avg_order_cents: a.orders > 0 ? Math.round(a.revenue_cents / a.orders) : null,
      monthly_revenue_cents: monthlyRevenue,
    },
  };
}

export function buildBusinessState(input: BuildInput): BusinessState {
  const s = input.stats ?? {};
  const t = s.traffic ?? {};
  const days = Math.max(1, int(s.days) || 30);

  const visitors = int(t.visitors), views = int(t.views);
  const prevVisitors = int(t.prev_visitors), prevViews = int(t.prev_views);
  const signups = int(s.signups?.current), prevSignups = int(s.signups?.previous);
  const leads = int(s.leads?.current), prevLeads = int(s.leads?.previous);

  // Money: the currency with the most net revenue is "the" revenue; orders count across all, the rest are listed apart.
  const cur = arr(s.money?.current), prevMoney = arr(s.money?.previous);
  const main = cur[0]?.currency ?? prevMoney[0]?.currency ?? 'usd';
  const orders = cur.reduce((a, r) => a + int(r.orders), 0);
  const prevOrders = prevMoney.reduce((a, r) => a + int(r.orders), 0);
  const revenue = Math.max(0, Math.round(n(cur.find((r) => r.currency === main)?.net_cents)));
  const prevRevenue = Math.max(0, Math.round(n(prevMoney.find((r) => r.currency === main)?.net_cents)));
  const others = cur.filter((r) => r.currency !== main).map((r) => ({ currency: r.currency, orders: int(r.orders), net_cents: Math.round(n(r.net_cents)) }));
  const refunds = cur.filter((r) => r.currency === main).reduce((a, r) => a + Math.abs(Math.round(n(r.refunds_cents))), 0);

  const lt = {
    views: int(s.lifetime?.views), orders: int(s.lifetime?.orders), signups: int(s.lifetime?.signups), leads: int(s.lifetime?.leads),
  };
  const liveDays = input.firstLiveAt ? Math.max(0, Math.floor((input.now.getTime() - input.firstLiveAt.getTime()) / DAY)) : null;
  const level = dataLevel(visitors, liveDays, lt);
  const windowDays = Math.max(1, Math.min(days, liveDays === null ? days : liveDays + 1));

  const conversions = orders + leads + signups;
  const conversionRate = visitors >= ENOUGH_VISITORS ? Math.min(100, Math.round((conversions / visitors) * 1000) / 10) : null;

  const sources = tidySources(arr(t.sources), input.ownHosts);
  const devices = arr(t.devices).map((d) => ({ device: String(d.device), visitors: int(d.visitors) }));

  const state: BusinessState = {
    schema: 1,
    computed_at: input.now.toISOString(),
    period_days: days,
    visitors, signups, orders,
    revenue_cents: revenue,
    currency: main,
    views, leads,
    data_level: level,
    live_days: liveDays,
    previous: { visitors: prevVisitors, views: prevViews, signups: prevSignups, orders: prevOrders, leads: prevLeads, revenue_cents: prevRevenue },
    changes: {
      visitors: change(visitors, prevVisitors, MIN_PREV_TRAFFIC),
      views: change(views, prevViews, MIN_PREV_TRAFFIC),
      signups: change(signups, prevSignups, MIN_PREV_EVENTS),
      orders: change(orders, prevOrders, MIN_PREV_EVENTS),
      leads: change(leads, prevLeads, MIN_PREV_EVENTS),
      revenue: change(revenue, prevRevenue, 1),
    },
    conversion_rate: conversionRate,
    pages: arr(t.pages).slice(0, 8).map((p) => ({ page: String(p.page), views: int(p.views), visitors: int(p.visitors) })),
    sources,
    devices,
    daily: arr(t.daily).map((d) => ({ day: String(d.day), views: int(d.views), visitors: int(d.visitors) })),
    products: arr(s.money?.products).filter((p) => p.currency === main).slice(0, 8).map((p) => ({ name: String(p.name), units: int(p.units), cents: int(p.cents) })),
    lead_sources: arr(s.leads?.by_collection).slice(0, 8).map((l) => ({ collection: String(l.collection), count: int(l.count) })),
    lifetime: lt,
    recent: arr(s.recent).slice(0, 8).flatMap((r) => (r.type === 'sale' || r.type === 'lead' || r.type === 'signup'
      ? [{ type: r.type, at: String(r.at), ...(r.what ? { what: String(r.what) } : {}), ...(r.cents !== undefined ? { cents: int(r.cents) } : {}), ...(r.currency ? { currency: String(r.currency) } : {}) }]
      : [])),
  };
  if (others.length) state.other_currencies = others;
  state.vs_plan = versusPlan(input.scenario, { visitors, orders, leads, signups, revenue_cents: revenue, window_days: windowDays });

  const notes: string[] = [];
  if (level === 'none') notes.push('Nothing has been recorded yet.');
  else if (level === 'early') notes.push(`Too early to read much into these numbers — they get meaningful after about ${ENOUGH_VISITORS} visitors and a week live.`);
  if (others.length) notes.push('Sales in other currencies are listed separately and are not added to the revenue figure.');
  if (level !== 'none') notes.push('Visits you make yourself are counted too.');
  if (notes.length) state.notes = notes;

  state.insights = insightsOf(state, { sells: !!input.sells, refunds, main });
  return state;
}

function insightsOf(st: BusinessState, ctx: { sells: boolean; refunds: number; main: string }): BusinessInsight[] {
  const out: BusinessInsight[] = [];
  const days = st.period_days;
  const level = st.data_level;
  if (level === 'none') {
    out.push({
      id: 'no_visits', tone: 'info',
      text: (st.live_days ?? 0) >= 1
        ? 'Nobody has visited yet. Share your address with a few people — the QR code on the Launch screen works well on print.'
        : 'Your site just went live. Share your address to get the first visitors.',
    });
    return out;
  }
  if (st.orders > 0) {
    out.push({ id: 'orders', tone: 'good', text: `${st.orders} ${st.orders === 1 ? 'order' : 'orders'} in the last ${days} days — ${formatMoney(st.revenue_cents, ctx.main)} after refunds.` });
    const top = st.products?.[0];
    if (top && (st.products?.length ?? 0) > 1) out.push({ id: 'top_product', tone: 'info', text: `${top.name} brings in the most (${formatMoney(top.cents, ctx.main)} from ${top.units} sold).` });
  } else if (ctx.sells && st.visitors >= 100) {
    out.push({ id: 'no_orders', tone: 'watch', text: `${st.visitors} people visited in the last ${days} days but nobody has bought yet.` });
  }
  if (ctx.refunds > 0) out.push({ id: 'refunds', tone: 'info', text: `${formatMoney(ctx.refunds, ctx.main)} was refunded in this period.` });
  if ((st.leads ?? 0) > 0) {
    const top = st.lead_sources?.[0];
    out.push({ id: 'leads', tone: 'good', text: `${st.leads} ${st.leads === 1 ? 'form entry' : 'form entries'} came in${top && (st.lead_sources?.length ?? 0) > 1 ? ` (most from “${top.collection}”)` : ''}.` });
  }
  if (st.signups > 0) out.push({ id: 'signups', tone: 'good', text: `${st.signups} ${st.signups === 1 ? 'person' : 'people'} signed up.` });

  if (level === 'ok') {
    const ch = st.changes?.visitors;
    if (ch !== null && ch !== undefined && ch >= 25) out.push({ id: 'visitors_up', tone: 'good', text: `Visitors are up ${ch}% on the ${days} days before.` });
    else if (ch !== null && ch !== undefined && ch <= -25) out.push({ id: 'visitors_down', tone: 'watch', text: `Visitors are down ${Math.abs(ch)}% on the ${days} days before.` });
    const src = st.sources?.[0];
    if (src && st.visitors > 0 && src.visitors / st.visitors >= 0.3 && src.source !== 'Direct') {
      out.push({ id: 'top_source', tone: 'info', text: `${Math.round((src.visitors / st.visitors) * 100)}% of visitors come from ${src.source}.` });
    }
    const mobile = st.devices?.find((d) => d.device === 'mobile');
    if (mobile && st.visitors > 0 && mobile.visitors / st.visitors >= 0.6) {
      out.push({ id: 'mostly_mobile', tone: 'info', text: `${Math.round((mobile.visitors / st.visitors) * 100)}% of visitors are on a phone — check the phone view when you edit.` });
    }
    if (st.conversion_rate !== null && st.conversion_rate !== undefined) {
      out.push({ id: 'conversion', tone: 'info', text: `${st.conversion_rate}% of visitors ${ctx.sells ? 'bought, signed up or sent a form' : 'signed up or sent a form'}.` });
    }
  } else {
    out.push({ id: 'early', tone: 'info', text: `${st.visitors} ${st.visitors === 1 ? 'visitor' : 'visitors'} so far — it's early, so don't read much into the trends yet.` });
  }
  return out.slice(0, 8);
}

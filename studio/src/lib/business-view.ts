// BUSINESS screen logic (REVAMP Step 13, chunk B) that needs no browser (unit-tested under Node, test/business-view.test.ts): reading the
// server's `business_state`, the headline cards, the "not enough data yet" banner, the daily bar chart geometry, the lists, and the plan
// next to what actually happened. components/BusinessStage.tsx is the thin shell; api/business.ts does the network.
// Honesty rules (the same the server keeps): a change arrow exists only when the server sent a number for it; nothing is estimated here.
import { timeAgo } from './format.ts';
import { validateArtifact, type BusinessInsight, type BusinessState, type BusinessVsPlan, type DataLevel } from '../types/artifacts.ts';

// ── reading the answer ───────────────────────────────────────────────────────

export type Period = 7 | 30 | 90;
export const PERIODS: readonly Period[] = [7, 30, 90];
export const DEFAULT_PERIOD: Period = 30;

export function periodLabel(p: Period): string {
  return `Last ${p} days`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Keep only the list entries a screen can draw (the server's validator checks list length, not what is inside). */
function list<T>(v: unknown, keep: (x: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const r = isObj(x) ? keep(x) : null;
    if (r) out.push(r);
  }
  return out;
}

/** The `state` the business-state function returns → a BusinessState the screen can trust, or null for anything else. */
export function readBusinessState(raw: unknown): BusinessState | null {
  const ok = validateArtifact('business_state', raw);
  if (!ok.ok) return null;
  const s = ok.value;
  return {
    ...s,
    pages: list(s.pages, (x) => (str(x.page) && num(x.views) !== null ? { page: str(x.page)!, views: num(x.views)!, visitors: num(x.visitors) ?? 0 } : null)),
    sources: list(s.sources, (x) => (str(x.source) && num(x.visitors) !== null ? { source: str(x.source)!, visitors: num(x.visitors)! } : null)),
    devices: list(s.devices, (x) => (str(x.device) && num(x.visitors) !== null ? { device: str(x.device)!, visitors: num(x.visitors)! } : null)),
    daily: list(s.daily, (x) => (str(x.day) && num(x.visitors) !== null ? { day: str(x.day)!, views: num(x.views) ?? 0, visitors: num(x.visitors)! } : null)),
    products: list(s.products, (x) => (str(x.name) && num(x.units) !== null && num(x.cents) !== null ? { name: str(x.name)!, units: num(x.units)!, cents: num(x.cents)! } : null)),
    recent: list(s.recent, (x) => {
      const type = x.type === 'sale' || x.type === 'lead' || x.type === 'signup' ? x.type : null;
      const at = str(x.at);
      if (!type || !at) return null;
      const out: NonNullable<BusinessState['recent']>[number] = { type, at };
      if (str(x.what)) out.what = str(x.what)!;
      if (num(x.cents) !== null) out.cents = num(x.cents)!;
      if (str(x.currency)) out.currency = str(x.currency)!;
      return out;
    }),
    insights: list(s.insights, (x): BusinessInsight | null => {
      const tone = x.tone === 'good' || x.tone === 'info' || x.tone === 'watch' ? x.tone : null;
      return tone && str(x.id) && str(x.text) ? { id: str(x.id)!, tone, text: str(x.text)! } : null;
    }),
    notes: Array.isArray(s.notes) ? s.notes.filter((n): n is string => typeof n === 'string' && n.length > 0) : [],
  };
}

// ── numbers ──────────────────────────────────────────────────────────────────

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

/** `cents` in the given currency (same output as the server's formatMoney). */
export function money(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export interface Change {
  pct: number;
  direction: 'up' | 'down' | 'flat';
  /** '▲ 25%' · '▼ 10%' · 'No change' */
  text: string;
  /** For screen readers: 'Up 25% on the 30 days before'. */
  label: string;
}

/** A change arrow, only when the server sent a number. Null stays null — "no arrow" is how the screen says "too early to compare". */
export function changeOf(pct: number | null | undefined, days: number): Change | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const when = `on the ${days} days before`;
  if (pct === 0) return { pct, direction: 'flat', text: 'No change', label: `No change ${when}` };
  const rounded = Math.abs(Math.round(pct));
  return pct > 0
    ? { pct, direction: 'up', text: `▲ ${rounded}%`, label: `Up ${rounded}% ${when}` }
    : { pct, direction: 'down', text: `▼ ${rounded}%`, label: `Down ${rounded}% ${when}` };
}

// ── the headline cards ───────────────────────────────────────────────────────

export interface StatCard {
  id: 'visitors' | 'orders' | 'revenue' | 'signups' | 'leads';
  label: string;
  value: string;
  change: Change | null;
  /** One quiet line under the number. */
  hint: string | null;
}

/** The numbers worth a card: visitors always; money when the site sells; sign-ups and form entries once there has been one. */
export function statCards(s: BusinessState, opts: { sells: boolean }): StatCard[] {
  const days = s.period_days;
  const cur = s.currency ?? 'usd';
  const ch = s.changes;
  const cards: StatCard[] = [
    { id: 'visitors', label: 'Visitors', value: formatCount(s.visitors), change: changeOf(ch?.visitors, days), hint: s.views ? `${formatCount(s.views)} page ${s.views === 1 ? 'view' : 'views'}` : null },
  ];
  if (opts.sells || s.orders > 0 || s.revenue_cents !== 0) {
    cards.push({ id: 'revenue', label: 'Revenue', value: money(s.revenue_cents, cur), change: changeOf(ch?.revenue, days), hint: 'After refunds' });
    cards.push({ id: 'orders', label: 'Orders', value: formatCount(s.orders), change: changeOf(ch?.orders, days), hint: s.conversion_rate != null ? `${s.conversion_rate}% of visitors` : null });
  }
  if (s.signups > 0 || (s.lifetime?.signups ?? 0) > 0) {
    cards.push({ id: 'signups', label: 'Sign-ups', value: formatCount(s.signups), change: changeOf(ch?.signups, days), hint: null });
  }
  if ((s.leads ?? 0) > 0 || (s.lifetime?.leads ?? 0) > 0) {
    cards.push({ id: 'leads', label: 'Form entries', value: formatCount(s.leads ?? 0), change: changeOf(ch?.leads, days), hint: null });
  }
  return cards;
}

// ── "not enough data yet" ────────────────────────────────────────────────────

export interface DataBanner {
  level: DataLevel;
  title: string;
  body: string;
}

/** The honest headline for the numbers: a young or empty site says so, and the figures below are shown without trend arrows. Null when the data is enough. */
export function dataBanner(s: BusinessState): DataBanner | null {
  const level = s.data_level ?? 'ok';
  if (level === 'none') {
    return { level, title: 'Waiting for your first visitor', body: 'Nothing has been recorded yet. Share your link — visits, sign-ups and sales show up here as they happen.' };
  }
  if (level === 'early') {
    return { level, title: 'Early days', body: 'Too early to read much into these numbers — they become meaningful after about 50 visitors and a week live. Trend arrows appear when there is enough to compare.' };
  }
  return null;
}

/** The server's own caveats, minus the ones the banner already says. */
export function extraNotes(s: BusinessState): string[] {
  const banner = dataBanner(s);
  return (s.notes ?? []).filter((n) => !(banner && /^(Nothing has been recorded|Too early to read)/.test(n)));
}

// ── the daily chart ──────────────────────────────────────────────────────────

export const CHART_W = 600;
export const CHART_H = 140;
/** A column is at most this wide however few days there are (never fill the slot). */
const BAR_MAX = 24;
const CORNER = 4;
const GAP = 2;

export interface Bar {
  day: string;
  value: number;
  /** The drawn column (rounded at the top, square on the baseline). Empty for a zero day. */
  path: string;
  /** The hover/focus target: the whole day's slot, full height — bigger than the mark. */
  slotX: number;
  slotW: number;
  /** 'Oct 14 — 12 visitors' */
  label: string;
}

export interface Chart {
  bars: Bar[];
  /** The top of the scale (a round number ≥ the biggest day). */
  top: number;
  /** y of the middle gridline and the baseline. */
  midY: number;
  baseY: number;
  first: string;
  last: string;
  peak: { day: string; value: number } | null;
}

/** 'YYYY-MM-DD…' → 'Oct 14' (read as a UTC calendar day, so no timezone shifts it). */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The smallest 1 / 2 / 5 × 10ⁿ that is ≥ n (and at least 4, so a quiet week doesn't look dramatic). */
export function niceTop(n: number): number {
  if (!(n > 4)) return 4;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 5, 10]) if (m * exp >= n) return m * exp;
  return 10 * exp;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A column from the baseline up, rounded only at the top. */
export function barPath(x: number, w: number, h: number, baseY: number): string {
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(CORNER, w / 2, h);
  const top = baseY - h;
  return `M${r1(x)} ${r1(baseY)}V${r1(top + r)}Q${r1(x)} ${r1(top)} ${r1(x + r)} ${r1(top)}H${r1(x + w - r)}Q${r1(x + w)} ${r1(top)} ${r1(x + w)} ${r1(top + r)}V${r1(baseY)}Z`;
}

/** Visitors per day as columns on one baseline. No data → no chart (null): the screen shows words, not an empty frame. */
export function dailyChart(daily: readonly { day: string; visitors: number }[] | undefined): Chart | null {
  if (!daily || daily.length === 0) return null;
  const max = Math.max(...daily.map((d) => d.visitors));
  if (!(max > 0)) return null;
  const top = niceTop(max);
  const pad = 6; // air above the top gridline
  const baseY = CHART_H;
  const plotH = CHART_H - pad;
  const slot = CHART_W / daily.length;
  const w = Math.max(1, Math.min(BAR_MAX, slot - GAP));
  let peak: Chart['peak'] = null;
  const bars = daily.map((d, i) => {
    const slotX = i * slot;
    const h = d.visitors > 0 ? Math.max(2, (d.visitors / top) * plotH) : 0;
    if (d.visitors > 0 && (!peak || d.visitors > peak.value)) peak = { day: d.day, value: d.visitors };
    return {
      day: d.day,
      value: d.visitors,
      path: barPath(slotX + (slot - w) / 2, w, h, baseY),
      slotX: r1(slotX),
      slotW: r1(slot),
      label: `${dayLabel(d.day)} — ${formatCount(d.visitors)} ${d.visitors === 1 ? 'visitor' : 'visitors'}`,
    };
  });
  return { bars, top, midY: r1(baseY - plotH / 2), baseY, first: dayLabel(daily[0]!.day), last: dayLabel(daily[daily.length - 1]!.day), peak };
}

// ── lists ────────────────────────────────────────────────────────────────────

export interface Row {
  key: string;
  name: string;
  /** '42' · '$12.00' */
  value: string;
  /** Secondary text, e.g. '3 sold'. */
  note: string | null;
  /** 0–100, share of the biggest row (for a thin bar). */
  width: number;
}

function rows(items: { name: string; n: number; value: string; note: string | null }[]): Row[] {
  const max = Math.max(1, ...items.map((i) => i.n));
  return items.map((i) => ({ key: i.name, name: i.name, value: i.value, note: i.note, width: Math.max(2, Math.round((i.n / max) * 100)) }));
}

export function sourceRows(s: BusinessState, limit = 6): Row[] {
  const total = s.visitors;
  return rows((s.sources ?? []).slice(0, limit).map((x) => ({
    name: x.source, n: x.visitors, value: formatCount(x.visitors), note: total > 0 ? `${Math.min(100, Math.round((x.visitors / total) * 100))}%` : null,
  })));
}

export function pageRows(s: BusinessState, limit = 6): Row[] {
  return rows((s.pages ?? []).slice(0, limit).map((x) => ({
    name: x.page, n: x.views, value: formatCount(x.views), note: `${formatCount(x.visitors)} ${x.visitors === 1 ? 'visitor' : 'visitors'}`,
  })));
}

const DEVICE_NAMES: Record<string, string> = { mobile: 'Phone', desktop: 'Computer', tablet: 'Tablet' };

/** The tracker records `mobile` / `desktop` / `tablet`; people read Phone / Computer / Tablet. Anything else is shown capitalised as it came. */
export function deviceName(raw: string): string {
  const known = DEVICE_NAMES[raw.toLowerCase()];
  return known ?? (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Unknown');
}

export function deviceRows(s: BusinessState): Row[] {
  return rows((s.devices ?? []).slice(0, 4).map((x) => ({ name: deviceName(x.device), n: x.visitors, value: formatCount(x.visitors), note: null })));
}

export function productRows(s: BusinessState, limit = 6): Row[] {
  const cur = s.currency ?? 'usd';
  return rows((s.products ?? []).slice(0, limit).map((x) => ({
    name: x.name, n: x.cents, value: money(x.cents, cur), note: `${formatCount(x.units)} sold`,
  })));
}

export interface ActivityLine {
  key: string;
  icon: string;
  text: string;
  when: string;
}

/** What just happened (no names or emails — the server never sends them). */
export function activityLines(s: BusinessState, now: number = Date.now()): ActivityLine[] {
  const cur = s.currency ?? 'usd';
  return (s.recent ?? []).slice(0, 8).map((r, i) => {
    const amount = r.cents !== undefined ? money(r.cents, r.currency ?? cur) : '';
    const text =
      r.type === 'sale' ? `Sale${r.what ? ` — ${r.what}` : ''}${amount ? ` · ${amount}` : ''}`
      : r.type === 'signup' ? 'New sign-up'
      : `Form entry${r.what ? ` — ${r.what}` : ''}`;
    return { key: `${r.at}-${i}`, icon: r.type === 'sale' ? '$' : r.type === 'signup' ? '＋' : '✉', text, when: timeAgo(r.at, now) };
  });
}

// ── the plan next to what happened ───────────────────────────────────────────

export interface PlanRow {
  id: 'visitors' | 'conversion' | 'order' | 'revenue';
  label: string;
  planned: string;
  actual: string;
  /** Where actual stands against planned: null when there is nothing to compare. */
  verdict: 'ahead' | 'on-track' | 'behind' | null;
}

function verdictOf(planned: number, actual: number | null): PlanRow['verdict'] {
  if (actual === null || !(planned > 0)) return null;
  const ratio = actual / planned;
  return ratio >= 1.1 ? 'ahead' : ratio >= 0.9 ? 'on-track' : 'behind';
}

export const VERDICT_TEXT: Record<NonNullable<PlanRow['verdict']>, string> = { ahead: 'Ahead of plan', 'on-track': 'About on plan', behind: 'Behind plan' };

/** Your plan's scenario beside what the last 30 days looked like (scaled to a month). The plan's numbers were assumptions, never promises. */
export function planRows(vs: BusinessVsPlan | null | undefined, currency = 'usd'): PlanRow[] {
  if (!vs) return [];
  const p = vs.planned;
  const a = vs.actual;
  return [
    { id: 'visitors', label: 'Visitors a month', planned: formatCount(p.monthly_visitors), actual: formatCount(a.monthly_visitors), verdict: verdictOf(p.monthly_visitors, a.monthly_visitors) },
    { id: 'conversion', label: 'Visitors who buy', planned: `${p.conversion_pct}%`, actual: a.conversion_pct === null ? '—' : `${a.conversion_pct}%`, verdict: verdictOf(p.conversion_pct, a.conversion_pct) },
    { id: 'order', label: 'Average order', planned: money(p.price_cents, currency), actual: a.avg_order_cents === null ? '—' : money(a.avg_order_cents, currency), verdict: verdictOf(p.price_cents, a.avg_order_cents) },
    { id: 'revenue', label: 'Revenue a month', planned: money(p.monthly_revenue_cents, currency), actual: money(a.monthly_revenue_cents, currency), verdict: verdictOf(p.monthly_revenue_cents, a.monthly_revenue_cents) },
  ];
}

// ── errors ───────────────────────────────────────────────────────────────────

/** Plain English for a failed numbers request. */
export function businessErrorText(e: unknown): string {
  const status = e && typeof e === 'object' && 'status' in e ? (e as { status?: unknown }).status : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 409) return 'Your site isn’t live yet, so there is nothing to measure. Launch it first.';
  if (status === 404) return 'We couldn’t find this project.';
  if (status === 401) return 'Please sign in again to see your numbers.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return 'Couldn’t reach the server. Check your connection and try again.';
  return msg || 'Something went wrong. Please try again.';
}

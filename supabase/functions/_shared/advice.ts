// BUSINESS partner (Step 13, chunk C): the AI business partner's rules, as pure TypeScript (runs in the business-partner edge function
// and in Node tests; the studio only imports the types).
//
// The model sees a numbered table of FACTS made from the saved `business_state` (plus a short description of the site from the plan and the
// manifest) and nothing else. It answers with recommendations that cite fact ids. Then THIS file decides what survives (`groundAdvice`):
//   * a recommendation must cite at least one fact that exists;
//   * every number in what the owner will read must be a number that appears in the facts (or a bare count of ten or fewer) — no invented
//     figures, no percentages the model worked out by itself;
//   * the evidence shown next to a recommendation is the fact's own line, taken from the state — never the model's wording;
//   * an `apply` instruction (what "Apply" sends to the TWEAKS pipeline) with a price or percentage that isn't a fact is dropped.
// So "grounded only in the state" is enforced by code, not just asked for in the prompt.
import type { BusinessState, Manifest, Plan } from './artifacts.ts';
import { formatMoney } from './business.ts';

export interface Fact {
  id: string;
  text: string;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  /** The facts the recommendation cites, as written from the state. */
  evidence: Fact[];
  /** A plain-language change to the site that "Apply" hands to the TWEAKS stage; null when the step isn't a site edit. */
  apply: string | null;
}

export interface Advice {
  /** The saved business_state version this advice was made from. */
  state_version: number;
  computed_at: string;
  period_days: number;
  /** One or two sentences, or ''. */
  headline: string;
  recommendations: Recommendation[];
}

export const MAX_RECOMMENDATIONS = 4;
const MAX_TITLE = 90;
const MAX_WHY = 420;
const MAX_HEADLINE = 220;
const MAX_APPLY = 300;

// ── the facts ───────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
const pct = (n: number): string => `${n > 0 ? '+' : ''}${n}%`;

/** Every statement the partner may rely on, each with a stable id. Built only from the state — nothing is added or estimated here. */
export function factsOf(st: BusinessState): Fact[] {
  const out: Fact[] = [];
  const days = st.period_days;
  const cur = st.currency ?? 'usd';
  const money = (c: number): string => formatMoney(c, cur);
  const prev = st.previous;
  const ch = st.changes;
  const add = (id: string, text: string) => out.push({ id, text });
  const trend = (c: number | null | undefined, before: number | undefined): string =>
    c !== null && c !== undefined && before !== undefined ? ` (${before} in the ${days} days before, ${pct(c)})` : '';

  add('period', `These numbers cover the last ${days} days${st.live_days !== null && st.live_days !== undefined ? `; the site has been live for ${plural(st.live_days, 'day')}` : ''}.`);
  add('visitors', `Visitors: ${st.visitors}${trend(ch?.visitors, prev?.visitors)}.`);
  if (st.views !== undefined) add('views', `Page views: ${st.views}${trend(ch?.views, prev?.views)}.`);
  if (st.conversion_rate !== null && st.conversion_rate !== undefined) add('conversion', `${st.conversion_rate}% of visitors ordered, signed up or sent a form.`);
  add('orders', `Orders: ${st.orders}${trend(ch?.orders, prev?.orders)}.`);
  if (st.orders > 0 || st.revenue_cents > 0) {
    const before = ch?.revenue !== null && ch?.revenue !== undefined && prev ? ` (${money(prev.revenue_cents)} in the ${days} days before, ${pct(ch.revenue)})` : '';
    add('revenue', `Revenue after refunds: ${money(st.revenue_cents)}${before}.`);
  }
  add('signups', `Sign-ups: ${st.signups}${trend(ch?.signups, prev?.signups)}.`);
  add('leads', `Form entries: ${st.leads ?? 0}${trend(ch?.leads, prev?.leads)}.`);
  (st.sources ?? []).slice(0, 5).forEach((s, i) => {
    const share = st.visitors > 0 ? `, ${Math.round((s.visitors / st.visitors) * 100)}% of visitors` : '';
    add(`source.${i + 1}`, `Visitors from ${s.source}: ${s.visitors}${share}.`);
  });
  (st.pages ?? []).slice(0, 5).forEach((p, i) => add(`page.${i + 1}`, `Page ${p.page}: ${plural(p.views, 'view')} from ${plural(p.visitors, 'visitor')}.`));
  (st.devices ?? []).slice(0, 3).forEach((d, i) => {
    const share = st.visitors > 0 ? `, ${Math.round((d.visitors / st.visitors) * 100)}% of visitors` : '';
    add(`device.${i + 1}`, `Visitors on ${d.device}: ${d.visitors}${share}.`);
  });
  (st.products ?? []).slice(0, 5).forEach((p, i) => add(`product.${i + 1}`, `${p.name}: ${plural(p.units, 'sale')}, ${money(p.cents)}.`));
  (st.lead_sources ?? []).slice(0, 4).forEach((l, i) => add(`form.${i + 1}`, `Form “${l.collection}”: ${plural(l.count, 'entry', 'entries')}.`));
  const vp = st.vs_plan;
  if (vp) {
    add('plan.traffic', `The plan expected ${vp.planned.monthly_visitors} visitors a month; the site is at ${vp.actual.monthly_visitors} a month.`);
    if (vp.actual.conversion_pct !== null) add('plan.conversion', `The plan expected ${vp.planned.conversion_pct}% of visitors to buy; it is ${vp.actual.conversion_pct}%.`);
    add('plan.revenue', `The plan expected ${money(vp.planned.monthly_revenue_cents)} a month; the site is at ${money(vp.actual.monthly_revenue_cents)} a month.`);
  }
  for (const i of st.insights ?? []) add(`insight.${i.id}`, i.text);
  return out;
}

// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────

interface Num {
  value: number;
  money: boolean;
  percent: boolean;
}

/** The numbers written in `text`: `$1,200.50`, `33%`, `412`. Thousands separators are ignored. */
export function numbersIn(text: string): Num[] {
  const out: Num[] = [];
  for (const m of text.matchAll(/(\$|£|€)?(\d[\d,]*(?:\.\d+)?)(%)?/g)) {
    const value = Number(m[2]!.replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ value, money: !!m[1], percent: !!m[3] });
  }
  return out;
}

const kindOf = (n: Num): string => (n.money ? 'money' : n.percent ? 'percent' : 'plain');
const keyOf = (n: Num): string => `${kindOf(n)}:${n.value}`;

/** The numbers the facts license, by kind: a percentage must be a fact's percentage, an amount of money a fact's amount (so "40%" is not
 *  licensed just because some fact says "40 visitors"). */
function licensed(facts: Fact[]): Set<string> {
  const s = new Set<string>();
  for (const f of facts) for (const n of numbersIn(f.text)) s.add(keyOf(n));
  return s;
}

/** True when every number in `text` is a fact's number (same kind), or a plain whole count of ten or fewer ("3 steps"). */
export function numbersAreGrounded(text: string, ok: Set<string>): boolean {
  return numbersIn(text).every((n) => ok.has(keyOf(n)) || (!n.money && !n.percent && Number.isInteger(n.value) && n.value <= 10));
}

// ── the prompt ──────────────────────────────────────────────────────────────────────────────────────

export const PARTNER_MARK = 'BUSINESS PARTNER';

const RULES = `You are the ${PARTNER_MARK} for the owner of one small website business. You talk to the owner as "you", in plain words a non-technical person understands. You are practical and honest.

You may rely ONLY on the FACTS and the SITE description below. Everything you say about the business's numbers must come from a fact.
- Quote numbers exactly as they are written in the facts. Never work out a new number: no new percentages, totals, averages, growth rates, forecasts, or "double/triple". If you want a number the facts don't contain, leave it out.
- Never claim anything about visitors, customers, or the market that the facts don't say. If the facts do not support advice, return an empty list — that is a good answer.
- Do not promise results ("this will bring more sales"). Say what the numbers suggest and what is worth trying.

Give between 1 and ${MAX_RECOMMENDATIONS} recommendations, the most valuable first. Each one is a single concrete thing the owner can do next, tied to what the numbers show.
- "cites": the ids of the facts the recommendation rests on (at least one, at most four).
- "apply": ONLY when the step is a change to the existing website that someone could make by editing the wording, emphasis or layout of content that is already on it — one imperative sentence, e.g. "Move the booking button into the first screen of the home page and make the wording more direct." Otherwise null (for steps like sharing the site, asking a friend to review it, or following up on an order).
  An "apply" must never ask to add reviews, testimonials, customer logos, statistics, new prices, new products, new forms or accounts, and must not contain a price or percentage that is not in the facts.

Reply with ONE JSON object and nothing else:
{"headline": "one or two sentences: how it is going", "recommendations": [{"id": "short-kebab-case-id", "title": "the step, in under 12 words", "why": "one or two sentences: what in the numbers points to this", "cites": ["fact-id"], "apply": "instruction or null"}]}`;

/** What the model is told about the site itself (from the plan and the built site's manifest). */
export function siteBlock(name: string, plan: Plan | null, manifest: Manifest | null): string {
  const lines = [`Name: ${name}`];
  if (plan) {
    if (plan.one_liner) lines.push(`What it is: ${plan.one_liner}`);
    if (plan.audience) lines.push(`Who it is for: ${plan.audience}`);
    if (plan.offer) lines.push(`What it offers: ${plan.offer}`);
  }
  const pages = manifest?.pages ?? plan?.pages ?? [];
  if (pages.length) lines.push(`Pages: ${pages.slice(0, 12).map((p) => `${p.file} (${p.title})`).join(', ')}`);
  const b = manifest?.backend ?? plan?.backend;
  if (b) {
    if (b.products?.length) lines.push(`Sells: ${b.products.slice(0, 8).join(', ')}`);
    if (b.forms?.length) lines.push(`Forms: ${b.forms.slice(0, 6).join(', ')}`);
    if (b.auth) lines.push('Has visitor accounts: yes');
  }
  return lines.join('\n');
}

export function partnerPrompt(input: { name: string; plan: Plan | null; manifest: Manifest | null; facts: Fact[] }): { system: string; user: string } {
  const system = `${RULES}\n\nSITE\n${siteBlock(input.name, input.plan, input.manifest)}\n\nFACTS (id: statement)\n${input.facts.map((f) => `${f.id}: ${f.text}`).join('\n')}`;
  return { system, user: 'Here is how my business is doing. What should I do next?' };
}

// ── the answer ──────────────────────────────────────────────────────────────────────────────────────

/** The first JSON object in the model's reply (it may be wrapped in a code fence or a sentence). null when there is none. */
export function parseReply(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export interface Grounded {
  headline: string;
  recommendations: Recommendation[];
  /** Why each discarded piece was discarded — logged, never shown. */
  dropped: string[];
}

/** Keep only what the facts back up. `raw` is the parsed model reply. */
export function groundAdvice(raw: Record<string, unknown> | null, facts: Fact[]): Grounded {
  const dropped: string[] = [];
  if (!raw) return { headline: '', recommendations: [], dropped: ['the reply was not JSON'] };
  const byId = new Map(facts.map((f) => [f.id, f]));
  const ok = licensed(facts);

  let headline = clean(raw.headline, MAX_HEADLINE);
  if (headline && !numbersAreGrounded(headline, ok)) {
    dropped.push('headline had a number that is not in the facts');
    headline = '';
  }

  const list = Array.isArray(raw.recommendations) ? raw.recommendations : [];
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = clean(r.title, MAX_TITLE);
    const why = clean(r.why, MAX_WHY);
    const label = title || '(untitled)';
    if (title.length < 5 || why.length < 10) { dropped.push(`“${label}” was too thin`); continue; }
    const cites = (Array.isArray(r.cites) ? r.cites : []).filter((c): c is string => typeof c === 'string');
    const evidence: Fact[] = [];
    for (const c of cites) {
      const f = byId.get(c);
      if (f && !evidence.some((e) => e.id === f.id)) evidence.push(f);
    }
    if (evidence.length === 0) { dropped.push(`“${label}” cited no fact that exists`); continue; }
    if (!numbersAreGrounded(title, ok) || !numbersAreGrounded(why, ok)) { dropped.push(`“${label}” had a number that is not in the facts`); continue; }

    let apply: string | null = clean(r.apply, MAX_APPLY) || null;
    if (apply && /^(null|none|n\/a)$/i.test(apply)) apply = null;
    // A site edit may not state a price or a percentage the numbers don't contain.
    if (apply && !numbersIn(apply).every((n) => (!n.money && !n.percent) || ok.has(keyOf(n)))) {
      dropped.push(`the change for “${label}” stated a price or percentage that is not in the facts`);
      apply = null;
    }

    let id = slug(clean(r.id, 60)) || slug(title) || `step-${recommendations.length + 1}`;
    while (seen.has(id)) id += '-2';
    seen.add(id);
    recommendations.push({ id, title, why, evidence: evidence.slice(0, 4), apply });
  }
  return { headline, recommendations, dropped };
}

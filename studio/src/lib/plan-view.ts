// Framework-free logic of the PLAN screen: the editable plan draft, the revenue what-if, the chat history sent to the model, and
// how a half-streamed reply is shown. Pure (unit-tested under Node, test/plan-view.test.ts); components/PlanStage.tsx does the UI.
import { emptyPlan, validateArtifact, type ChecklistItem, type PlannedPage, type Plan, type PricingItem, type PricingModel, type RevenueScenario } from '../types/artifacts.ts';

export const PRICING_MODELS: { value: PricingModel; label: string }[] = [
  { value: 'none', label: 'Not decided yet' },
  { value: 'free', label: 'Free' },
  { value: 'one_time', label: 'One-time purchase' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'donation', label: 'Donations' },
  { value: 'quote', label: 'Custom quote' },
];

export const CHECKLIST_TYPES: { value: ChecklistItem['type']; label: string }[] = [
  { value: 'photo', label: 'Photo' },
  { value: 'text', label: 'Text' },
  { value: 'product', label: 'Product' },
  { value: 'legal', label: 'Legal' },
  { value: 'domain', label: 'Domain' },
  { value: 'other', label: 'Other' },
];

// ── reading what is stored ──────────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const names = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Stored artifact data → a complete Plan, whatever is missing or malformed (a plan from a future version, a hand-edited row). */
export function readPlan(data: unknown, fallbackName = 'Untitled'): Plan {
  const base = emptyPlan(fallbackName);
  if (!isObj(data)) return base;
  const pricing = isObj(data.pricing) ? data.pricing : {};
  const models = PRICING_MODELS.map((m) => m.value as string);
  const backend = isObj(data.backend) ? data.backend : {};
  const scenario = isObj(data.scenario)
    ? { price_cents: num(data.scenario.price_cents), monthly_visitors: num(data.scenario.monthly_visitors), conversion_pct: num(data.scenario.conversion_pct) }
    : null;
  const plan: Plan = {
    ...(data as Partial<Plan>),
    schema: 1,
    name: text(data.name) || fallbackName,
    kind: data.kind === 'app' ? 'app' : 'site',
    one_liner: text(data.one_liner),
    audience: text(data.audience),
    offer: text(data.offer),
    pricing: {
      model: models.includes(text(pricing.model)) ? (pricing.model as PricingModel) : 'none',
      items: list(pricing.items).filter(isObj).map((i): PricingItem => ({
        name: text(i.name),
        price_cents: Math.max(0, Math.round(num(i.price_cents))),
        ...(i.interval === 'month' || i.interval === 'year' ? { interval: i.interval } : {}),
      })),
    },
    pages: Array.isArray(data.pages)
      ? list(data.pages).filter(isObj).map((p): PlannedPage => ({ file: text(p.file), title: text(p.title), purpose: text(p.purpose) }))
      : base.pages,
    backend: { collections: names(backend.collections), products: names(backend.products), forms: names(backend.forms), auth: backend.auth === true },
    launch_checklist: list(data.launch_checklist).filter(isObj).map((c): ChecklistItem => ({
      id: text(c.id) || 'item',
      label: text(c.label),
      type: CHECKLIST_TYPES.some((t) => t.value === c.type) ? (c.type as ChecklistItem['type']) : 'other',
      done: c.done === true,
    })),
    scenario,
  };
  if (typeof data.notes === 'string') plan.notes = data.notes;
  else delete plan.notes;
  return plan;
}

/** Same content? (key order does not matter) */
export function samePlan(a: Plan, b: Plan): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ── editing the draft (always returns a new plan) ───────────────────────────────────────────────────
export function setText(plan: Plan, field: 'name' | 'one_liner' | 'audience' | 'offer', value: string): Plan {
  return { ...plan, [field]: value };
}
export function setNotes(plan: Plan, value: string): Plan {
  if (value) return { ...plan, notes: value };
  const { notes: _dropped, ...rest } = plan;
  return rest;
}
export function setPricingModel(plan: Plan, model: PricingModel): Plan {
  return { ...plan, pricing: { ...plan.pricing, model } };
}
export function addPriceItem(plan: Plan): Plan {
  return { ...plan, pricing: { ...plan.pricing, items: [...plan.pricing.items, { name: '', price_cents: 0 }] } };
}
export function updatePriceItem(plan: Plan, index: number, patch: Partial<PricingItem>): Plan {
  const items = plan.pricing.items.map((it, i) => {
    if (i !== index) return it;
    const next = { ...it, ...patch };
    if (next.interval === undefined) delete next.interval;
    return next;
  });
  return { ...plan, pricing: { ...plan.pricing, items } };
}
export function removePriceItem(plan: Plan, index: number): Plan {
  return { ...plan, pricing: { ...plan.pricing, items: plan.pricing.items.filter((_, i) => i !== index) } };
}
export function addPage(plan: Plan): Plan {
  let n = plan.pages.length + 1;
  while (plan.pages.some((p) => p.file === `page-${n}.html`)) n++;
  return { ...plan, pages: [...plan.pages, { file: `page-${n}.html`, title: '', purpose: '' }] };
}
export function updatePage(plan: Plan, index: number, patch: Partial<PlannedPage>): Plan {
  return { ...plan, pages: plan.pages.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}
export function removePage(plan: Plan, index: number): Plan {
  return { ...plan, pages: plan.pages.filter((_, i) => i !== index) };
}
export function setBackendList(plan: Plan, field: 'collections' | 'products' | 'forms', value: string[]): Plan {
  return { ...plan, backend: { ...plan.backend, [field]: value } };
}
export function setAuth(plan: Plan, auth: boolean): Plan {
  return { ...plan, backend: { ...plan.backend, auth } };
}
export function addChecklistItem(plan: Plan, label: string): Plan {
  const clean = label.trim();
  if (!clean) return plan;
  let n = plan.launch_checklist.length + 1;
  while (plan.launch_checklist.some((c) => c.id === `item-${n}`)) n++;
  return { ...plan, launch_checklist: [...plan.launch_checklist, { id: `item-${n}`, label: clean, type: 'other', done: false }] };
}
export function toggleChecklistItem(plan: Plan, id: string): Plan {
  return { ...plan, launch_checklist: plan.launch_checklist.map((c) => (c.id === id ? { ...c, done: !c.done } : c)) };
}
export function removeChecklistItem(plan: Plan, id: string): Plan {
  return { ...plan, launch_checklist: plan.launch_checklist.filter((c) => c.id !== id) };
}

/** "forms, newsletter ,," → ['forms', 'newsletter'] (one name per comma-separated entry, trimmed, no empties, no repeats). */
export function parseNameList(value: string): string[] {
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

// ── revenue what-if ─────────────────────────────────────────────────────────────────────────────────
/** What the owner's own numbers add up to per month, in cents: visitors × conversion % × price. A calculator, not a forecast. */
export function scenarioMonthlyCents(s: RevenueScenario): number {
  return Math.round(s.monthly_visitors * (s.conversion_pct / 100) * s.price_cents);
}

/** Editable starting numbers for the what-if, taken from the plan's first price. null = there is no price to start from yet. */
export function startScenario(plan: Plan): RevenueScenario | null {
  const item = plan.pricing.items.find((i) => i.price_cents > 0);
  return item ? { price_cents: item.price_cents, monthly_visitors: 1000, conversion_pct: 2 } : null;
}

export function setScenario(plan: Plan, patch: Partial<RevenueScenario> | null): Plan {
  if (patch === null) return { ...plan, scenario: null };
  const cur = plan.scenario ?? { price_cents: 0, monthly_visitors: 0, conversion_pct: 0 };
  const next = { ...cur, ...patch };
  return {
    ...plan,
    scenario: {
      price_cents: Math.max(0, Math.round(next.price_cents)),
      monthly_visitors: Math.max(0, Math.round(next.monthly_visitors)),
      conversion_pct: Math.min(100, Math.max(0, next.conversion_pct)),
    },
  };
}

/** 1299 → "12.99" (no currency symbol: the plan does not record one). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
/** "12.99" / "12,99" / " 7 " → 1299 / 1299 / 700. Anything that is not a non-negative amount → null. */
export function inputToCents(value: string): number | null {
  const v = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}
export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── what the server would refuse, in words ──────────────────────────────────────────────────────────
/** One validator message ("pages[1].title: is required") → a sentence about what the owner sees. */
export function describeProblem(error: string): string {
  const at = error.indexOf(': ');
  const path = at < 0 ? error : error.slice(0, at);
  const msg = at < 0 ? '' : error.slice(at + 2);
  let m = /^pages\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) {
    const n = Number(m[1]) + 1;
    if (m[2] === 'title') return `Page ${n} needs a title`;
    if (m[2] === 'file') return `Page ${n} needs a simple file name like about.html`;
    return `Page ${n}: ${msg}`;
  }
  m = /^pricing\.items\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) {
    const n = Number(m[1]) + 1;
    return m[2] === 'name' ? `Price ${n} needs a name` : `Price ${n}: ${msg}`;
  }
  m = /^launch_checklist\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) return m[2] === 'label' ? `Checklist item ${Number(m[1]) + 1} needs a label` : `Checklist item ${Number(m[1]) + 1}: ${msg}`;
  if (path === 'name') return 'The plan needs a name (up to 120 characters)';
  if (path === 'notes') return 'The notes are too long (2000 characters at most)';
  if (path.startsWith('scenario')) return `Revenue what-if: ${msg}`;
  return error;
}

/** Everything wrong with a draft, as sentences ([] = the server will take it). */
export function planProblems(plan: Plan): string[] {
  const r = validateArtifact('plan', plan);
  return r.ok ? [] : r.errors.map(describeProblem);
}

/** "About Us" → "about-us.html"; keeps only what a page file name may contain. Empty stays empty. */
export function cleanFileName(value: string): string {
  const base = value.trim().toLowerCase().replace(/\.html?$/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z0-9]+/, '');
  return base ? `${base}.html` : '';
}

// ── hints before moving on ──────────────────────────────────────────────────────────────────────────
/** Soft nudges for "Continue" — the server only needs a saved, fresh plan, so none of these block. */
export function planHints(plan: Plan): string[] {
  const out: string[] = [];
  if (!plan.one_liner.trim()) out.push('add a one-line description');
  if (!plan.audience.trim()) out.push("say who it's for");
  if (!plan.offer.trim()) out.push('say what you offer');
  if (plan.pricing.model === 'none' && plan.pricing.items.length === 0) out.push('decide how you will charge (or pick "Free")');
  if (plan.pages.length === 0) out.push('list at least one page');
  return out;
}

/** The project is still called "Untitled" and the plan has a real name → rename the project to it. null = leave the name alone. */
export function syncedName(projectName: string, planName: string): string | null {
  const current = projectName.trim();
  const wanted = planName.trim();
  if (current && current !== 'Untitled') return null;
  if (!wanted || wanted === 'Untitled' || wanted === current) return null;
  return wanted.slice(0, 120);
}

// ── the conversation ────────────────────────────────────────────────────────────────────────────────
export interface ChatLine {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** A row of `stage_messages` → ChatLine, or null for junk. */
export function toChatLine(row: unknown): ChatLine | null {
  if (!isObj(row) || typeof row.id !== 'string') return null;
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  if (typeof row.content !== 'string' || !row.content) return null;
  return { id: row.id, role: row.role, content: row.content };
}

/** Must equal ARTIFACT_OPEN in supabase/functions/ai-chat/stages.ts (test/plan-view.test.ts checks). */
export const ARTIFACT_MARK = '[[ARTIFACT]]';

/**
 * What to show of a reply that is still arriving: the chat part, and whether the plan block has begun (then the rest is hidden —
 * the owner sees "Updating your plan…", never the JSON). A marker that is only half arrived ("[[ARTI") is hidden too.
 */
export function splitLiveReply(raw: string): { chat: string; updating: boolean } {
  const at = raw.indexOf(ARTIFACT_MARK);
  if (at >= 0) return { chat: raw.slice(0, at).trimEnd(), updating: true };
  for (let n = Math.min(ARTIFACT_MARK.length - 1, raw.length); n > 0; n--) {
    if (raw.endsWith(ARTIFACT_MARK.slice(0, n))) return { chat: raw.slice(0, raw.length - n).trimEnd(), updating: false };
  }
  return { chat: raw, updating: false };
}

export const MAX_HISTORY = 30;

/**
 * The conversation to send: the last `max` lines, starting with a user line (a model needs the first turn to be the user's) —
 * everything older is already folded into the plan the server sends with every request. Ends with the user line being answered.
 */
export function historyToSend(lines: readonly ChatLine[], max: number = MAX_HISTORY): { role: 'user' | 'assistant'; content: string }[] {
  let tail = lines.slice(-max);
  while (tail.length > 0 && tail[0]!.role !== 'user') tail = tail.slice(1);
  return tail.map(({ role, content }) => ({ role, content }));
}

/** The message a "Try again" re-sends: the conversation must end with the owner's own line (the one that got no answer). */
export function canRetry(lines: readonly ChatLine[]): boolean {
  return lines.length > 0 && lines[lines.length - 1]!.role === 'user';
}

export const GREETING = "Tell me about your idea — even one sentence is enough. I'll draft a plan you can change, and ask only what I need to know.";
export const NOT_SURE_MESSAGE = "I'm not sure yet what I want to make. Can you help me figure it out?";

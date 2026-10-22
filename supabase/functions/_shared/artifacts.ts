// The five artifacts the stages hand to each other, as types + a structural validator. Pure TypeScript, no imports (runs in
// the studio, Deno edge functions and Node tests — see _shared/stages.ts for how the stage rules use them).
//
// Shape policy: every artifact has `schema: 1`; unknown extra keys are allowed and preserved (a later step can add fields without
// a migration — the database only guarantees "a JSON object ≤ 256 KB"). validateArtifact() is the semantic gate: the studio calls it
// before saving, and ai-chat calls it before it saves anything the model produced. Steps 8–13 flesh out the optional fields.
import type { ArtifactKind } from './stages.ts';

export const ARTIFACT_SCHEMA = 1 as const;

// ── PLAN ───────────────────────────────────────────────────────────────────────────────────────────
export type PricingModel = 'free' | 'one_time' | 'subscription' | 'donation' | 'quote' | 'none';
export interface PricingItem {
  name: string;
  price_cents: number;
  interval?: 'month' | 'year';
}
export interface PlannedPage {
  /** File name, e.g. "index.html" */
  file: string;
  title: string;
  purpose: string;
}
/** Something only the owner can supply (real photos, legal text, testimonials…). Collected here, verified before launch. */
export interface ChecklistItem {
  id: string;
  label: string;
  type: 'photo' | 'text' | 'legal' | 'product' | 'domain' | 'other';
  done: boolean;
}
/** Revenue scenario — visible, editable assumptions, never a promise (REVAMP "Locked decisions"). */
export interface RevenueScenario {
  price_cents: number;
  monthly_visitors: number;
  conversion_pct: number;
}
export interface Plan {
  schema: 1;
  name: string;
  /** site = marketing/content/commerce site, app = logged-in product (docs/PROJECT_FORMAT.md) */
  kind: 'site' | 'app';
  one_liner: string;
  audience: string;
  offer: string;
  pricing: { model: PricingModel; items: PricingItem[] };
  pages: PlannedPage[];
  backend: { collections: string[]; products: string[]; forms: string[]; auth: boolean };
  launch_checklist: ChecklistItem[];
  scenario: RevenueScenario | null;
  notes?: string;
}

// ── EXAMPLE BUILD → style ──────────────────────────────────────────────────────────────────────────
export interface StyleSpec {
  schema: 1;
  /** "Lock this style": the full build must obey it. Required (true) before the BUILD stage can be entered. */
  locked: boolean;
  vibe: { theme: 'light' | 'dark'; density: 'compact' | 'comfortable' | 'airy'; tone: string };
  /** CSS custom properties exactly as they appear in styles.css :root, e.g. { "--accent": "#7c3aed" } */
  tokens: Record<string, string>;
  fonts: { display: string; body: string; import_url?: string };
  /** One-line voice/tone note the copy must follow. */
  voice?: string;
  /** The art-direction spec the example build was made from (layout archetype, signature move…), opaque to the engine. */
  art_direction?: Record<string, unknown>;
}

// ── FULL BUILD → manifest ──────────────────────────────────────────────────────────────────────────
export interface ManifestPage {
  file: string;
  title: string;
  in_nav?: boolean;
}
export interface Manifest {
  schema: 1;
  built_at: string;
  pages: ManifestPage[];
  shared_files: string[];
  backend: { collections: string[]; products: string[]; forms: string[]; auth: boolean };
  /** What the build cost, in cents (cost accounting, Step 10). */
  cost_cents?: number;
}

// ── launch verifier → launch_checks ────────────────────────────────────────────────────────────────
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface LaunchCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  page?: string;
}
export interface LaunchChecks {
  schema: 1;
  checked_at: string;
  /** Which manifest version this report describes. */
  manifest_version: number;
  /** true = nothing failed (warnings allowed). The Step 12 launch gate re-checks server-side. */
  ok: boolean;
  checks: LaunchCheck[];
  /** needs_from_owner items still open. */
  open_items: string[];
}

// ── BUSINESS ───────────────────────────────────────────────────────────────────────────────────────
/** How much the numbers can be trusted: none = nothing recorded yet, early = a young site or a handful of visits, ok = enough to read. */
export type DataLevel = 'none' | 'early' | 'ok';
export interface BusinessInsight {
  id: string;
  tone: 'good' | 'info' | 'watch';
  text: string;
}
/** Computed by the platform from rows that exist (page views, Stripe-webhook transactions, sign-ups, form entries) — never estimated.
 *  The fields after `notes` arrived in Step 13 and are all optional so older saved states still validate. */
export interface BusinessState {
  schema: 1;
  computed_at: string;
  period_days: number;
  visitors: number;
  signups: number;
  orders: number;
  /** Net of refunds, in the main currency (`currency`). */
  revenue_cents: number;
  /** Caveats the screen shows next to the numbers ("too early to read much into this"). */
  notes?: string[];
  currency?: string;
  views?: number;
  /** Form entries (every collection except transactions). */
  leads?: number;
  data_level?: DataLevel;
  /** Whole days since the first publish; null when unknown. */
  live_days?: number | null;
  /** The same counts for the period before this one. */
  previous?: { visitors: number; views: number; signups: number; orders: number; leads: number; revenue_cents: number };
  /** % change vs the previous period; null while the earlier number is too small to mean anything. */
  changes?: { visitors: number | null; views: number | null; signups: number | null; orders: number | null; leads: number | null; revenue: number | null };
  /** % of visitors who ordered, signed up or sent a form; null until 50 visitors. */
  conversion_rate?: number | null;
  pages?: { page: string; views: number; visitors: number }[];
  sources?: { source: string; visitors: number }[];
  devices?: { device: string; visitors: number }[];
  daily?: { day: string; views: number; visitors: number }[];
  products?: { name: string; units: number; cents: number }[];
  lead_sources?: { collection: string; count: number }[];
  other_currencies?: { currency: string; orders: number; net_cents: number }[];
  recent?: { type: 'sale' | 'lead' | 'signup'; at: string; what?: string; cents?: number; currency?: string }[];
  lifetime?: { views: number; orders: number; signups: number; leads: number };
  /** The plan's revenue scenario next to what actually happened; null until there is a scenario and a week of data. */
  vs_plan?: BusinessVsPlan | null;
  insights?: BusinessInsight[];
}
export interface BusinessVsPlan {
  planned: { monthly_visitors: number; conversion_pct: number; price_cents: number; monthly_revenue_cents: number };
  /** Everything scaled to 30 days. conversion_pct / avg_order_cents are null until there is anything to divide by. */
  actual: { monthly_visitors: number; conversion_pct: number | null; avg_order_cents: number | null; monthly_revenue_cents: number };
}

export interface ArtifactByKind {
  plan: Plan;
  style_spec: StyleSpec;
  manifest: Manifest;
  launch_checks: LaunchChecks;
  business_state: BusinessState;
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────────
export type ValidationResult<K extends ArtifactKind> = { ok: true; value: ArtifactByKind[K] } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

class Errors {
  list: string[] = [];
  add(path: string, msg: string) {
    this.list.push(`${path}: ${msg}`);
  }
}

function checkBackend(v: unknown, path: string, e: Errors) {
  if (!isObj(v)) return e.add(path, 'must be an object');
  for (const k of ['collections', 'products', 'forms'] as const) if (!isStrArray(v[k])) e.add(`${path}.${k}`, 'must be a list of names');
  if (typeof v.auth !== 'boolean') e.add(`${path}.auth`, 'must be true or false');
}

function checkList(v: unknown, path: string, e: Errors, item: (x: unknown, p: string) => void, max = 100) {
  if (!Array.isArray(v)) return e.add(path, 'must be a list');
  if (v.length > max) e.add(path, `has more than ${max} entries`);
  v.slice(0, max).forEach((x, i) => item(x, `${path}[${i}]`));
}

function validatePlan(d: Obj, e: Errors) {
  if (!isNonEmptyStr(d.name) || d.name.length > 120) e.add('name', 'is required (max 120 characters)');
  if (d.kind !== 'site' && d.kind !== 'app') e.add('kind', 'must be "site" or "app"');
  for (const k of ['one_liner', 'audience', 'offer'] as const) if (!isStr(d[k])) e.add(k, 'must be text');
  if (!isObj(d.pricing)) e.add('pricing', 'must be an object');
  else {
    const models = ['free', 'one_time', 'subscription', 'donation', 'quote', 'none'];
    if (!isStr(d.pricing.model) || !models.includes(d.pricing.model)) e.add('pricing.model', `must be one of ${models.join(', ')}`);
    checkList(d.pricing.items, 'pricing.items', e, (x, p) => {
      if (!isObj(x)) return e.add(p, 'must be an object');
      if (!isNonEmptyStr(x.name)) e.add(`${p}.name`, 'is required');
      if (!isInt(x.price_cents) || (x.price_cents as number) < 0) e.add(`${p}.price_cents`, 'must be a whole number of cents ≥ 0');
      if (x.interval !== undefined && x.interval !== 'month' && x.interval !== 'year') e.add(`${p}.interval`, 'must be "month" or "year"');
    }, 50);
  }
  checkList(d.pages, 'pages', e, (x, p) => {
    if (!isObj(x)) return e.add(p, 'must be an object');
    if (!isStr(x.file) || !/^[a-z0-9][a-z0-9_-]*\.html$/i.test(x.file)) e.add(`${p}.file`, 'must be a simple .html file name');
    if (!isNonEmptyStr(x.title)) e.add(`${p}.title`, 'is required');
    if (!isStr(x.purpose)) e.add(`${p}.purpose`, 'must be text');
  }, 30);
  checkBackend(d.backend, 'backend', e);
  if (d.notes !== undefined && (!isStr(d.notes) || d.notes.length > 2000)) e.add('notes', 'must be text (max 2000 characters)');
  const types = ['photo', 'text', 'legal', 'product', 'domain', 'other'];
  checkList(d.launch_checklist, 'launch_checklist', e, (x, p) => {
    if (!isObj(x)) return e.add(p, 'must be an object');
    if (!isNonEmptyStr(x.id)) e.add(`${p}.id`, 'is required');
    if (!isNonEmptyStr(x.label)) e.add(`${p}.label`, 'is required');
    if (!isStr(x.type) || !types.includes(x.type)) e.add(`${p}.type`, `must be one of ${types.join(', ')}`);
    if (typeof x.done !== 'boolean') e.add(`${p}.done`, 'must be true or false');
  }, 100);
  if (d.scenario !== null) {
    if (!isObj(d.scenario)) e.add('scenario', 'must be an object or null');
    else {
      if (!isNum(d.scenario.price_cents) || d.scenario.price_cents < 0) e.add('scenario.price_cents', 'must be a number ≥ 0');
      if (!isNum(d.scenario.monthly_visitors) || d.scenario.monthly_visitors < 0) e.add('scenario.monthly_visitors', 'must be a number ≥ 0');
      if (!isNum(d.scenario.conversion_pct) || d.scenario.conversion_pct < 0 || d.scenario.conversion_pct > 100) e.add('scenario.conversion_pct', 'must be between 0 and 100');
    }
  }
}

/**
 * A CSS custom-property value we are willing to write into a stylesheet: short, one line, and unable to close the declaration, the
 * rule or a comment (no semicolon, braces, angle brackets, backslash, newline, or comment opener/closer). Style specs are saved by
 * clients and by the model, and later written into styles.css, so nothing may smuggle in a second rule.
 */
export function isSafeTokenValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[;{}<>\\\n\r]|\/\*|\*\//.test(v);
}

/** The only font host we load, as a URL that is safe to put inside `@import url('…')` (no quotes, parentheses, spaces or backslashes). */
export function isSafeFontUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https:\/\/fonts\.googleapis\.com\/[A-Za-z0-9:@;=&+,._%/?!*-]{1,600}$/.test(v);
}

function validateStyleSpec(d: Obj, e: Errors) {
  if (typeof d.locked !== 'boolean') e.add('locked', 'must be true or false');
  if (!isObj(d.vibe)) e.add('vibe', 'must be an object');
  else {
    if (d.vibe.theme !== 'light' && d.vibe.theme !== 'dark') e.add('vibe.theme', 'must be "light" or "dark"');
    if (!['compact', 'comfortable', 'airy'].includes(d.vibe.density as string)) e.add('vibe.density', 'must be compact, comfortable or airy');
    if (!isStr(d.vibe.tone)) e.add('vibe.tone', 'must be text');
  }
  if (!isObj(d.tokens)) e.add('tokens', 'must be an object');
  else
    for (const [k, v] of Object.entries(d.tokens)) {
      if (!/^--[a-z0-9-]+$/i.test(k)) e.add(`tokens.${k}`, 'must be a CSS custom property name like --accent');
      else if (!isSafeTokenValue(v)) e.add(`tokens.${k}`, 'must be a plain CSS value');
    }
  if (!isObj(d.fonts)) e.add('fonts', 'must be an object');
  else {
    if (!isNonEmptyStr(d.fonts.display)) e.add('fonts.display', 'is required');
    if (!isNonEmptyStr(d.fonts.body)) e.add('fonts.body', 'is required');
    if (d.fonts.import_url !== undefined && !isSafeFontUrl(d.fonts.import_url)) {
      e.add('fonts.import_url', 'must be a https://fonts.googleapis.com/ URL');
    }
  }
}

function validateManifest(d: Obj, e: Errors) {
  if (!isNonEmptyStr(d.built_at)) e.add('built_at', 'is required');
  checkList(d.pages, 'pages', e, (x, p) => {
    if (!isObj(x)) return e.add(p, 'must be an object');
    if (!isNonEmptyStr(x.file)) e.add(`${p}.file`, 'is required');
    if (!isStr(x.title)) e.add(`${p}.title`, 'must be text');
  }, 100);
  if (!isStrArray(d.shared_files)) e.add('shared_files', 'must be a list of file names');
  checkBackend(d.backend, 'backend', e);
}

function validateLaunchChecks(d: Obj, e: Errors) {
  if (!isNonEmptyStr(d.checked_at)) e.add('checked_at', 'is required');
  if (!isInt(d.manifest_version) || (d.manifest_version as number) < 1) e.add('manifest_version', 'must be a positive whole number');
  if (typeof d.ok !== 'boolean') e.add('ok', 'must be true or false');
  if (!isStrArray(d.open_items)) e.add('open_items', 'must be a list of text');
  checkList(d.checks, 'checks', e, (x, p) => {
    if (!isObj(x)) return e.add(p, 'must be an object');
    if (!isNonEmptyStr(x.id)) e.add(`${p}.id`, 'is required');
    if (!isNonEmptyStr(x.label)) e.add(`${p}.label`, 'is required');
    if (!['pass', 'fail', 'warn', 'skip'].includes(x.status as string)) e.add(`${p}.status`, 'must be pass, fail, warn or skip');
  }, 500);
  // An "ok" report that contains a failure is exactly the kind of record the launch gate must never trust.
  if (d.ok === true && Array.isArray(d.checks) && d.checks.some((c) => isObj(c) && c.status === 'fail')) e.add('ok', 'cannot be true while a check failed');
}

function validateBusinessState(d: Obj, e: Errors) {
  if (!isNonEmptyStr(d.computed_at)) e.add('computed_at', 'is required');
  for (const k of ['period_days', 'visitors', 'signups', 'orders', 'revenue_cents'] as const) {
    if (!isInt(d[k]) || (d[k] as number) < 0) e.add(k, 'must be a whole number ≥ 0');
  }
  if (d.notes !== undefined && !isStrArray(d.notes)) e.add('notes', 'must be a list of text');
  if (d.data_level !== undefined && !['none', 'early', 'ok'].includes(d.data_level as string)) e.add('data_level', 'must be none, early or ok');
  for (const k of ['pages', 'sources', 'devices', 'daily', 'products', 'lead_sources', 'other_currencies', 'recent', 'insights'] as const) {
    if (d[k] !== undefined && (!Array.isArray(d[k]) || (d[k] as unknown[]).length > 400)) e.add(k, 'must be a list of at most 400');
  }
}

const VALIDATORS: Record<ArtifactKind, (d: Obj, e: Errors) => void> = {
  plan: validatePlan,
  style_spec: validateStyleSpec,
  manifest: validateManifest,
  launch_checks: validateLaunchChecks,
  business_state: validateBusinessState,
};

/** Structural check of an artifact before it is saved. Never throws; returns every problem found (max 20). */
export function validateArtifact<K extends ArtifactKind>(kind: K, data: unknown): ValidationResult<K> {
  if (!isObj(data)) return { ok: false, errors: ['data: must be a JSON object'] };
  const e = new Errors();
  if (data.schema !== ARTIFACT_SCHEMA) e.add('schema', `must be ${ARTIFACT_SCHEMA}`);
  VALIDATORS[kind](data, e);
  return e.list.length ? { ok: false, errors: e.list.slice(0, 20) } : { ok: true, value: data as unknown as ArtifactByKind[K] };
}

/**
 * Models like to write `"interval": null` for "not applicable". Optional fields are simply absent in our shapes, so drop every null
 * except the ones where null is the meaning ("scenario": null = no revenue scenario yet). Returns a copy; never throws.
 */
export function normalizeArtifact(data: unknown): unknown {
  const KEEP_NULL = new Set(['scenario']);
  const walk = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === null && !(top && KEEP_NULL.has(k))) continue;
        out[k] = walk(x, false);
      }
      return out;
    }
    return v;
  };
  return walk(data, true);
}

// ── starting points ────────────────────────────────────────────────────────────────────────────────
/** An empty-but-valid plan: what the PLAN stage starts from for a brand-new project. */
export function emptyPlan(name = 'Untitled'): Plan {
  return {
    schema: 1,
    name,
    kind: 'site',
    one_liner: '',
    audience: '',
    offer: '',
    pricing: { model: 'none', items: [] },
    pages: [{ file: 'index.html', title: 'Home', purpose: 'Landing page' }],
    backend: { collections: [], products: [], forms: [], auth: false },
    launch_checklist: [],
    scenario: null,
  };
}

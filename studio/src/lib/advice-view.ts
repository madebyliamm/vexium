// The AI business partner, as the BUSINESS screen shows it (REVAMP Step 13, chunk C). Pure: no network, no DOM — unit-tested.
// The server already refuses anything the numbers don't back up (supabase/functions/_shared/advice.ts); this re-checks the SHAPE of what
// arrives (an old cache, a bad proxy, a future server) so the screen never draws something it can't stand behind, and turns every way an
// ask can fail into a sentence a business owner can act on.
import { periodLabel, type Period } from './business-view.ts';
import { timeAgo } from './format.ts';
import type { BusinessState } from '../types/artifacts.ts';

/** One number the server read off the owner's own figures, in its own words ("120 visitors in the last 30 days"). */
export interface Evidence { id: string; text: string }

export interface Rec {
  id: string;
  title: string;
  why: string;
  evidence: Evidence[];
  /** A plain-language edit to the site (what Apply sends to TWEAKS), or null when the step is not a site edit. */
  apply: string | null;
}

export interface PartnerAdvice {
  /** The saved numbers this advice was made from. */
  state_version: number;
  computed_at: string;
  period_days: number;
  headline: string;
  recommendations: Rec[];
}

export type PartnerReply =
  | { status: 'ok'; advice: PartnerAdvice }
  | { status: 'not_enough_data'; level: 'none' | 'early'; message: string };

const MAX_RECS = 4;
const MAX_EVIDENCE = 4;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The advice the server sent, checked; null when it isn't advice at all. Recommendations with no title, no reason or no evidence are left out. */
export function readAdvice(raw: unknown): PartnerAdvice | null {
  if (!isObj(raw)) return null;
  const { state_version, period_days, computed_at } = raw;
  if (typeof state_version !== 'number' || !Number.isFinite(state_version)) return null;
  if (typeof period_days !== 'number' || !Number.isFinite(period_days)) return null;
  if (typeof computed_at !== 'string' || Number.isNaN(Date.parse(computed_at))) return null;
  if (!Array.isArray(raw.recommendations)) return null;
  const seen = new Set<string>();
  const recommendations: Rec[] = [];
  for (const r of raw.recommendations) {
    if (recommendations.length >= MAX_RECS) break;
    if (!isObj(r)) continue;
    const id = text(r.id, 60);
    const title = text(r.title, 140);
    const why = text(r.why, 500);
    if (!id || !title || !why || seen.has(id)) continue;
    const evidence: Evidence[] = [];
    if (Array.isArray(r.evidence)) {
      for (const e of r.evidence) {
        if (!isObj(e)) continue;
        const eid = text(e.id, 60);
        const etext = text(e.text, 240);
        if (eid && etext) evidence.push({ id: eid, text: etext });
        if (evidence.length >= MAX_EVIDENCE) break;
      }
    }
    // "Tied to numbers" is the whole point: a suggestion that points at none does not get drawn.
    if (evidence.length === 0) continue;
    const apply = text(r.apply, 500);
    seen.add(id);
    recommendations.push({ id, title, why, evidence, apply: apply || null });
  }
  return { state_version, computed_at, period_days, headline: text(raw.headline, 400), recommendations };
}

/** The whole `business-partner` answer; null when it is neither advice nor "not enough data". */
export function readPartnerReply(raw: unknown): PartnerReply | null {
  if (!isObj(raw)) return null;
  if (raw.status === 'not_enough_data') {
    const level = raw.level === 'early' ? 'early' : 'none';
    return { status: 'not_enough_data', level, message: text(raw.message, 400) || WAIT_TEXT[level] };
  }
  if (raw.status !== 'ok') return null;
  const advice = readAdvice(raw.advice);
  return advice ? { status: 'ok', advice } : null;
}

/** What the screen says on its own when there is too little to go on — no ask, no cost. Same promise the server makes. */
export const WAIT_TEXT = {
  none: 'There’s nothing to go on yet — nobody has visited your site. Once people start visiting, I’ll have something to say.',
  early: 'It’s too early for advice that means anything. After about 50 visitors and a week live, there’s enough to read — I’ll be here.',
} as const;

/** Enough numbers to ask? (The server decides again; this only spares a click that could not give an answer.) */
export function partnerReady(state: BusinessState): boolean {
  return (state.data_level ?? 'ok') === 'ok';
}

// ── a failed ask ─────────────────────────────────────────────────────────────

export interface AskProblem {
  text: string;
  /** The saved numbers were too old (or missing): refresh them, then ask once more. */
  refresh: boolean;
}

function bodyOf(e: unknown): { code: string; retryAfter: number | null } {
  const raw = e && typeof e === 'object' && 'body' in e ? (e as { body?: unknown }).body : '';
  if (typeof raw !== 'string' || !raw) return { code: '', retryAfter: null };
  try {
    const o: unknown = JSON.parse(raw);
    if (!isObj(o)) return { code: '', retryAfter: null };
    return {
      code: typeof o.error === 'string' ? o.error : '',
      retryAfter: typeof o.retry_after === 'number' && Number.isFinite(o.retry_after) && o.retry_after > 0 ? o.retry_after : null,
    };
  } catch {
    return { code: '', retryAfter: null };
  }
}

/** "a minute" / "about 20 minutes" for a wait in seconds. */
export function waitText(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  if (m <= 1) return 'a minute';
  if (m >= 60) return 'an hour';
  return `about ${m} minutes`;
}

export function askProblem(e: unknown): AskProblem {
  const status = e && typeof e === 'object' && 'status' in e ? (e as { status?: unknown }).status : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  const { code, retryAfter } = bodyOf(e);
  if (status === 409 && (code === 'state_old' || code === 'no_state')) return { text: 'Those numbers are a bit old. Refreshing them…', refresh: true };
  if (status === 409) return { text: 'Your site isn’t live yet, so there is nothing to look at. Launch it first.', refresh: false };
  if (status === 404) return { text: 'We couldn’t find this project.', refresh: false };
  if (status === 401) return { text: 'Please sign in again to ask your partner.', refresh: false };
  if (status === 429) return { text: `You’ve asked a lot in the last hour. Try again in ${waitText(retryAfter ?? 1800)}.`, refresh: false };
  // 402 / 503 / 502: the server words these for the owner (and never mentions its AI provider's account).
  if (status === 402) return { text: msg || 'You’ve used up your AI credits for now.', refresh: false };
  if (status === 503 || status === 502) return { text: msg || 'Your business partner is not available right now. Please try again later.', refresh: false };
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return { text: 'Couldn’t reach the server. Check your connection and try again.', refresh: false };
  return { text: msg || 'Something went wrong. Please try again.', refresh: false };
}

// ── what the advice was made from ────────────────────────────────────────────

/** 'current' = the numbers on screen; otherwise the owner switched period or refreshed since asking. */
export function adviceBasis(advice: PartnerAdvice, state: BusinessState | null): 'current' | 'other_period' | 'older' {
  if (!state) return 'current';
  if (advice.period_days !== state.period_days) return 'other_period';
  return advice.computed_at === state.computed_at ? 'current' : 'older';
}

/** "Based on your numbers for the last 30 days, from 3 min ago." (and a warning when the screen has moved on) */
export function basisNote(advice: PartnerAdvice, state: BusinessState | null, now: number = Date.now()): string {
  const range = periodLabel(advice.period_days as Period).toLowerCase();
  const when = timeAgo(advice.computed_at, now) || 'a moment ago';
  const base = `Based on your numbers for the ${range}, from ${when}.`;
  const basis = adviceBasis(advice, state);
  if (basis === 'other_period') return `${base} You’re looking at a different range now — ask again to match it.`;
  if (basis === 'older') return `${base} Your numbers have changed since — ask again for fresh advice.`;
  return base;
}

/** What Apply sends to TWEAKS, or null when the recommendation is not a site change. */
export function applyText(rec: Rec): string | null {
  const t = rec.apply?.trim();
  return t ? t : null;
}

// ── keeping it across screens ────────────────────────────────────────────────
// Apply takes the owner to TWEAKS and back, which re-mounts the BUSINESS screen: without this the advice (and what was already applied)
// would be gone — and asking again costs credits. sessionStorage: this tab only, gone when it closes.

export interface StoredAdvice { advice: PartnerAdvice; applied: string[] }
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Advice older than this is not kept: the business has moved on. */
export const KEEP_MS = 24 * 60 * 60 * 1000;
const key = (projectId: string) => `vx.partner.${projectId}`;

export function saveAdvice(kv: KV, projectId: string, value: StoredAdvice): void {
  try { kv.setItem(key(projectId), JSON.stringify(value)); } catch { /* storage full or blocked: the advice just won't survive a re-mount */ }
}

export function loadAdvice(kv: KV, projectId: string, now: number = Date.now()): StoredAdvice | null {
  let raw: string | null = null;
  try { raw = kv.getItem(key(projectId)); } catch { return null; }
  if (!raw) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (!isObj(o)) return null;
    const advice = readAdvice(o.advice);
    if (!advice) return null;
    if (now - Date.parse(advice.computed_at) > KEEP_MS) { try { kv.removeItem(key(projectId)); } catch { /* ignore */ } return null; }
    const ids = new Set(advice.recommendations.map((r) => r.id));
    const applied = Array.isArray(o.applied) ? o.applied.filter((a): a is string => typeof a === 'string' && ids.has(a)) : [];
    return { advice, applied };
  } catch {
    return null;
  }
}

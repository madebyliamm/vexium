// LAUNCH screen logic (REVAMP Step 12) that needs no browser (unit-tested under Node, test/launch-view.test.ts): the site address, whether
// the site may go live and what is in the way, the "draft has changes" hint, the saved live versions, and plain-English publish errors.
// components/LaunchStage.tsx is the thin shell around this; api/launch.ts does the network.
import { timeAgo } from './format.ts';
import { readManifest, reportView } from './build-view.ts';
import type { LaunchChecks } from '../types/artifacts.ts';

// ── the address ──────────────────────────────────────────────────────────────

/** The publisher's rule for a site address (publisher/src/publish.ts SLUG_RE): lowercase letters, digits, hyphens; not starting with a hyphen. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SLUG_MAX = 63;

/** The address the publisher would pick from a project name (same rule as publisher/src/publish.ts `slugFrom`). */
export function slugFrom(name: string): string {
  return ((name || 'my-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-site').slice(0, SLUG_MAX).replace(/-+$/g, '') || 'my-site';
}

/** Tidy what the owner typed into the address box as they type: lowercase, spaces → hyphens, only allowed characters, no leading hyphen. */
export function cleanSlug(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, SLUG_MAX);
}

/** Why this address can't be used, in words, or null when it can. */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'Choose an address for your site.';
  if (!SLUG_RE.test(slug) || slug.endsWith('-')) return 'Use only lowercase letters, numbers and hyphens, and don’t end with a hyphen.';
  return null;
}

export interface SiteAddress {
  /** What a person reads and types: `liam.vexium.ai/cafe` or their own domain. */
  display: string;
  href: string;
}

/** Where the site lives. A connected custom domain wins; otherwise `<username>.vexium.ai/<slug>`. Unknown username → null. */
export function siteAddress(x: { username: string | null; slug: string; customDomain?: string | null }): SiteAddress | null {
  const custom = (x.customDomain ?? '').trim().toLowerCase();
  if (custom) return { display: custom, href: `https://${custom}` };
  const user = (x.username ?? '').trim().toLowerCase();
  if (!user || !x.slug) return null;
  return { display: `${user}.vexium.ai/${x.slug}`, href: `https://${user}.vexium.ai/${x.slug}` };
}

// ── may it go live? ──────────────────────────────────────────────────────────

export type PaymentsState = 'not-needed' | 'ready' | 'not-connected' | 'unknown';

/** The site sells things (the build wired checkout for products) → payments must be connected before visitors can pay. */
export function paymentsState(x: { products: number; connected: boolean | null }): PaymentsState {
  if (x.products <= 0) return 'not-needed';
  if (x.connected === null) return 'unknown';
  return x.connected ? 'ready' : 'not-connected';
}

export type CheckState = 'pass' | 'warn' | 'fail' | 'todo';

export interface ChecklistRow {
  id: 'site' | 'payments' | 'address' | 'content';
  state: CheckState;
  label: string;
  detail: string;
}

export interface LaunchGate {
  /** The big button is open. */
  canPublish: boolean;
  /** Everything in the way, in words. Empty when canPublish. */
  blockers: string[];
  rows: ChecklistRow[];
}

/** The pre-launch checklist and the one decision it feeds: may the site go live now? Failed checks and an unconnected shop block; warnings never do. */
export function launchGate(x: {
  report: LaunchChecks | null;
  /** The saved report was made for an older build of the site. */
  reportOutdated: boolean;
  /** The site has been built (a manifest exists). */
  built: boolean;
  products: number;
  /** Stripe is ready to take payments; null = could not find out. */
  paymentsConnected: boolean | null;
  /** The Stripe lookup is still under way (so null means "not yet", not "could not"). */
  paymentsChecking?: boolean;
  slug: string;
}): LaunchGate {
  const rows: ChecklistRow[] = [];
  const blockers: string[] = [];

  // 1. the site itself
  if (!x.built) {
    rows.push({ id: 'site', state: 'fail', label: 'Your site is built', detail: 'Build the site first.' });
    blockers.push('Build your site first.');
  } else if (!x.report) {
    rows.push({ id: 'site', state: 'todo', label: 'Final check', detail: 'Run the check before you go live.' });
    blockers.push('Run the final check.');
  } else if (x.reportOutdated) {
    rows.push({ id: 'site', state: 'todo', label: 'Final check', detail: 'The last check is for an older version of the site.' });
    blockers.push('Check again — the last check is for an older version of the site.');
  } else {
    const v = reportView(x.report);
    if (v.fails.length > 0) {
      rows.push({ id: 'site', state: 'fail', label: 'Your site works', detail: v.headline });
      blockers.push(`Fix ${v.fails.length === 1 ? 'the problem' : `the ${v.fails.length} problems`} the check found.`);
    } else if (v.warns.length > 0) {
      rows.push({ id: 'site', state: 'warn', label: 'Your site works', detail: v.headline });
    } else {
      rows.push({ id: 'site', state: 'pass', label: 'Your site works', detail: v.headline });
    }
    // 2. things only the owner can supply
    if (v.openItems.length > 0) {
      rows.push({ id: 'content', state: 'warn', label: 'Still to add', detail: `${v.openItems.length} ${v.openItems.length === 1 ? 'thing' : 'things'} from your plan — you can add ${v.openItems.length === 1 ? 'it' : 'them'} after you go live.` });
    }
  }

  // 3. payments
  const pay = paymentsState({ products: x.products, connected: x.paymentsConnected });
  if (pay === 'ready') rows.push({ id: 'payments', state: 'pass', label: 'You can get paid', detail: 'Stripe is connected.' });
  else if (pay === 'not-connected') {
    rows.push({ id: 'payments', state: 'fail', label: 'You can get paid', detail: 'Your site sells things — connect Stripe so visitors can pay you.' });
    blockers.push('Connect Stripe so your visitors can pay you.');
  } else if (pay === 'unknown' && x.paymentsChecking) {
    rows.push({ id: 'payments', state: 'todo', label: 'You can get paid', detail: 'Checking your Stripe connection…' });
    blockers.push('Still checking your Stripe connection.');
  } else if (pay === 'unknown') {
    rows.push({ id: 'payments', state: 'todo', label: 'You can get paid', detail: 'Couldn’t check Stripe just now. Try again in a moment.' });
    blockers.push('Couldn’t check your Stripe connection — try again.');
  }

  // 4. the address
  const problem = slugProblem(x.slug);
  if (problem) {
    rows.push({ id: 'address', state: 'fail', label: 'Your address', detail: problem });
    blockers.push(problem);
  } else rows.push({ id: 'address', state: 'pass', label: 'Your address', detail: 'Ready to use.' });

  return { canPublish: blockers.length === 0, blockers, rows };
}

/** The products a built site sells (from the saved manifest), 0 when unknown. */
export function productCount(manifestData: unknown): number {
  return readManifest(manifestData)?.backend?.products.length ?? 0;
}

// ── live state ───────────────────────────────────────────────────────────────

/** `projects.updated_at` moves on every write, including the publisher's own (a few ms after `published_at`), so a small gap is not a change. */
export const PUBLISH_SKEW_MS = 30 * 1000;

/** The draft was changed after the live version was published. A hint only — any edit to the project row counts. */
export function draftIsAhead(x: { updatedAt: string | null; publishedAt: string | null }): boolean {
  const u = Date.parse(x.updatedAt ?? '');
  const p = Date.parse(x.publishedAt ?? '');
  if (Number.isNaN(u) || Number.isNaN(p)) return false;
  return u - p > PUBLISH_SKEW_MS;
}

export type LaunchStatus = 'ready' | 'blocked' | 'publishing' | 'live' | 'live-changes';

export function launchStatus(x: { published: boolean; publishing: boolean; canPublish: boolean; draftAhead: boolean }): LaunchStatus {
  if (x.publishing) return 'publishing';
  if (x.published) return x.draftAhead ? 'live-changes' : 'live';
  return x.canPublish ? 'ready' : 'blocked';
}

// ── saved live versions ──────────────────────────────────────────────────────

export interface Deploy {
  version: number;
  createdAt: string;
  files: number;
  bytes: number;
  isLive: boolean;
}

export const DEPLOY_COLUMNS = 'version,status,created_at,file_count,total_bytes';

/** `project_deploys` rows → versions that can be gone back to (status ready only), newest first, with the live one marked. */
export function readDeploys(rows: unknown, liveVersion: number | null): Deploy[] {
  if (!Array.isArray(rows)) return [];
  const out: Deploy[] = [];
  for (const r of rows) {
    const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    if (!x || x.status !== 'ready' || typeof x.version !== 'number' || !Number.isInteger(x.version)) continue;
    out.push({
      version: x.version,
      createdAt: typeof x.created_at === 'string' ? x.created_at : '',
      files: typeof x.file_count === 'number' ? x.file_count : 0,
      bytes: typeof x.total_bytes === 'number' ? x.total_bytes : 0,
      isLive: x.version === liveVersion,
    });
  }
  return out.sort((a, b) => b.version - a.version);
}

export function deployLine(d: Deploy, now: number = Date.now()): string {
  const when = timeAgo(d.createdAt, now);
  return `Version ${d.version}${when ? ` · ${when}` : ''}`;
}

// ── errors ───────────────────────────────────────────────────────────────────

/** Plain English for a failed publish. The publisher already words its own errors; this covers the network and the unknowns. */
export function publishErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return 'Couldn’t reach the server. Check your connection and try again — your live site was not changed.';
  return msg || 'Something went wrong. Your live site was not changed.';
}

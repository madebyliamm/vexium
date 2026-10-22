// FULL BUILD screen logic (REVAMP Step 10): the progress checklist from `build_steps`, the launch-check report, the cost line, and which
// files the preview needs. Pure (unit-tested under Node, test/build-view.test.ts); components/BuildStage.tsx owns the DOM and api/build.ts
// the I/O. The server's wording rules: no jargon, no "AI model" names, one plain sentence per thing.

import type { LaunchCheck, LaunchChecks, Manifest } from '../types/artifacts.ts';

/** What the Worker records as the owner's chat line when they give no direction. Must equal BUILD_DEFAULT_MESSAGE in ai-chat/build-prompts.ts. */
export const BUILD_DEFAULT_MESSAGE = 'Build my site';
export const BUILD_NOTE_MAX = 2000;

/** The chat message that starts a build: the owner's direction, or the default line. */
export function buildMessage(note: string): string {
  const t = note.trim().slice(0, BUILD_NOTE_MAX);
  return t || BUILD_DEFAULT_MESSAGE;
}

// ── the checklist ──────────────────────────────────────────────────────────────────────────────────

export type StepKind = 'prepare' | 'page' | 'fix' | 'verify' | 'save';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type ItemState = 'todo' | 'active' | 'done' | 'failed' | 'skipped';

/** A `build_steps` row (the columns the studio may read — never `output`). */
export interface StepRow {
  seq: number;
  kind: StepKind;
  file: string | null;
  label: string;
  status: StepStatus;
  attempt: number;
  detail: string | null;
  cost_cents: number;
}

export const STEP_COLUMNS = 'seq,kind,file,label,status,attempt,detail,cost_cents';

const KINDS: readonly StepKind[] = ['prepare', 'page', 'fix', 'verify', 'save'];
const STATUSES: readonly StepStatus[] = ['pending', 'running', 'done', 'failed', 'skipped'];

/** Rows from the database → StepRows. Anything that is not a step is dropped; numbers arrive as numbers or numeric strings. */
export function readSteps(rows: unknown): StepRow[] {
  if (!Array.isArray(rows)) return [];
  const out: StepRow[] = [];
  for (const raw of rows) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!r || typeof r.seq !== 'number' || typeof r.label !== 'string') continue;
    if (!KINDS.includes(r.kind as StepKind) || !STATUSES.includes(r.status as StepStatus)) continue;
    const cost = Number(r.cost_cents);
    out.push({
      seq: r.seq,
      kind: r.kind as StepKind,
      file: typeof r.file === 'string' ? r.file : null,
      label: r.label,
      status: r.status as StepStatus,
      attempt: typeof r.attempt === 'number' ? r.attempt : 0,
      detail: typeof r.detail === 'string' && r.detail ? r.detail : null,
      cost_cents: Number.isFinite(cost) && cost > 0 ? cost : 0,
    });
  }
  return out;
}

/** Where each kind sits in the list: setup, the pages, the check, the repairs it asked for, the save. */
const RANK: Record<StepKind, number> = { prepare: 0, page: 1, verify: 2, fix: 3, save: 4 };

export interface ChecklistItem {
  seq: number;
  kind: StepKind;
  label: string;
  state: ItemState;
  /** A short explanation shown under the label (a failure's reason, "second try"…). */
  note: string | null;
}

const STATE_OF: Record<StepStatus, ItemState> = { pending: 'todo', running: 'active', done: 'done', failed: 'failed', skipped: 'skipped' };

export function checklist(steps: readonly StepRow[]): ChecklistItem[] {
  return [...steps]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.seq - b.seq)
    .map((s): ChecklistItem => {
      let note: string | null = null;
      if (s.status === 'failed') note = s.detail ?? 'This did not work.';
      else if (s.status === 'running' && s.attempt >= 1) note = `Trying again (try ${s.attempt + 1})`;
      else if (s.status === 'done' && s.kind !== 'verify' && s.attempt >= 2) note = 'Needed a second try';
      else if (s.status === 'done' && s.kind === 'verify') note = s.detail;
      else if (s.status === 'running' && s.kind === 'verify') note = s.detail;
      return { seq: s.seq, kind: s.kind, label: s.label, state: STATE_OF[s.status], note };
    });
}

export interface Progress {
  done: number;
  total: number;
  percent: number;
}

/** How far along the build is: every row that is finished (done or skipped) over every row that exists. */
export function progress(steps: readonly StepRow[]): Progress {
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line that says what the build is doing right now. */
export function headline(steps: readonly StepRow[]): string {
  if (steps.length === 0) return 'Getting ready…';
  const pages = steps.filter((s) => s.kind === 'page');
  const pagesDone = pages.filter((s) => s.status === 'done').length;
  const fixing = steps.filter((s) => s.kind === 'fix' && (s.status === 'running' || s.status === 'pending'));
  const verify = steps.find((s) => s.kind === 'verify');
  const save = steps.find((s) => s.kind === 'save');
  if (save?.status === 'running') return 'Saving your site…';
  if (fixing.length > 0) return `Fixing ${plural(fixing.length, 'page')}…`;
  if (verify?.status === 'running') return 'Checking links, forms and checkout…';
  if (pagesDone < pages.length) return `Building your pages — ${pagesDone} of ${pages.length} done`;
  return 'Almost there…';
}

// ── cost ───────────────────────────────────────────────────────────────────────────────────────────

export function totalCost(steps: readonly StepRow[]): number {
  return steps.reduce((sum, s) => sum + s.cost_cents, 0);
}

/** "$0.42" / "less than 1¢" / "$3.10". */
export function formatCost(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '$0.00';
  if (cents < 1) return 'less than 1¢';
  return `$${(Math.round(cents) / 100).toFixed(2)}`;
}

// ── the built site ─────────────────────────────────────────────────────────────────────────────────

export interface SitePage {
  file: string;
  title: string;
  inNav: boolean;
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)$/;

/** The manifest's pages (valid names only), home page first. */
export function readManifest(data: unknown): { pages: SitePage[]; costCents: number | null; builtAt: string | null; backend: Manifest['backend'] | null } | null {
  const m = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (!m || !Array.isArray(m.pages)) return null;
  const pages: SitePage[] = [];
  for (const p of m.pages) {
    const x = p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
    if (!x || typeof x.file !== 'string' || !FILE_RE.test(x.file) || !x.file.endsWith('.html')) continue;
    pages.push({ file: x.file, title: typeof x.title === 'string' && x.title ? x.title : x.file, inNav: x.in_nav === true });
  }
  if (pages.length === 0) return null;
  pages.sort((a, b) => (a.file === 'index.html' ? -1 : b.file === 'index.html' ? 1 : 0));
  const b = m.backend && typeof m.backend === 'object' ? (m.backend as Record<string, unknown>) : null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  return {
    pages,
    costCents: typeof m.cost_cents === 'number' && Number.isFinite(m.cost_cents) ? m.cost_cents : null,
    builtAt: typeof m.built_at === 'string' ? m.built_at : null,
    backend: b ? { collections: list(b.collections), products: list(b.products), forms: list(b.forms), auth: b.auth === true } : null,
  };
}

/** The files the preview needs: every page, the stylesheet and the site script. */
export function previewFileNames(pages: readonly SitePage[]): string[] {
  return [...pages.map((p) => p.file), 'styles.css', 'site.js'];
}

/** The PostgREST `select` that reads those files as text columns c0, c1…, plus how to map a row back. The key is quoted (it has a dot). */
export function previewSelect(names: readonly string[]): string {
  return names.map((n, i) => `c${i}:files->>"${n}"`).join(',');
}
export function previewFilesFromRow(names: readonly string[], row: unknown): Record<string, string> {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    const v = r[`c${i}`];
    if (typeof v === 'string') out[n] = v;
  });
  return out;
}

/** What one backend looks like to the owner: "2 forms, checkout for 3 products, accounts". Empty when the site has no backend. */
export function backendSummary(b: Manifest['backend'] | null): string {
  if (!b) return '';
  const parts: string[] = [];
  if (b.forms.length) parts.push(plural(b.forms.length, 'form'));
  if (b.products.length) parts.push(`checkout for ${plural(b.products.length, 'product')}`);
  // A form's submissions are stored in a collection of the same name; only the other collections are lists of their own.
  const lists = b.collections.filter((c) => !b.forms.includes(c));
  if (lists.length) parts.push(plural(lists.length, 'data list'));
  if (b.auth) parts.push('accounts');
  return parts.join(', ');
}

// ── the launch-check report ────────────────────────────────────────────────────────────────────────

export function readReport(data: unknown): LaunchChecks | null {
  const r = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (!r || !Array.isArray(r.checks) || typeof r.ok !== 'boolean') return null;
  const checks: LaunchCheck[] = [];
  for (const c of r.checks) {
    const x = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!x || typeof x.id !== 'string' || typeof x.label !== 'string') continue;
    if (x.status !== 'pass' && x.status !== 'fail' && x.status !== 'warn' && x.status !== 'skip') continue;
    checks.push({
      id: x.id,
      label: x.label,
      status: x.status,
      ...(typeof x.detail === 'string' && x.detail ? { detail: x.detail } : {}),
      ...(typeof x.page === 'string' && x.page ? { page: x.page } : {}),
    });
  }
  return {
    schema: 1,
    checked_at: typeof r.checked_at === 'string' ? r.checked_at : '',
    manifest_version: typeof r.manifest_version === 'number' ? r.manifest_version : 0,
    ok: r.ok,
    checks,
    open_items: Array.isArray(r.open_items) ? r.open_items.filter((s): s is string => typeof s === 'string') : [],
  };
}

export interface ReportView {
  /** Nothing failed. */
  ok: boolean;
  headline: string;
  fails: LaunchCheck[];
  warns: LaunchCheck[];
  passes: LaunchCheck[];
  skipped: LaunchCheck[];
  openItems: string[];
}

export function reportView(report: LaunchChecks): ReportView {
  const by = (s: LaunchCheck['status']): LaunchCheck[] => report.checks.filter((c) => c.status === s);
  const fails = by('fail'), warns = by('warn'), passes = by('pass'), skipped = by('skip');
  let line: string;
  if (fails.length > 0) line = `${plural(fails.length, 'problem')} to fix${warns.length ? `, ${plural(warns.length, 'thing')} worth a look` : ''}`;
  else if (warns.length > 0) line = `Everything works — ${plural(warns.length, 'thing')} worth a look`;
  else line = `All ${plural(passes.length, 'check')} passed`;
  return { ok: fails.length === 0 && report.ok, headline: line, fails, warns, passes, skipped, openItems: report.open_items };
}

// ── the screen's state ─────────────────────────────────────────────────────────────────────────────

export type BuildStatus = 'ready' | 'building' | 'built' | 'outdated' | 'failed';

export function buildStatus(x: { running: boolean; built: boolean; stale: boolean; failed: boolean }): BuildStatus {
  if (x.running) return 'building';
  if (x.failed && !x.built) return 'failed';
  if (!x.built) return 'ready';
  return x.stale ? 'outdated' : 'built';
}

export const BUILD_STATUS_LABELS: Record<BuildStatus, string> = {
  ready: 'Ready to build',
  building: 'Building…',
  built: 'Built',
  outdated: 'Out of date',
  failed: "Didn't finish",
};

/** Why "Build" is closed right now, in words, or null when it can run. */
export function buildBlocker(x: { hasPlan: boolean; planStale: boolean; hasStyle: boolean; styleStale: boolean; styleLocked: boolean }): string | null {
  if (!x.hasPlan) return 'Make your plan first.';
  if (x.planStale) return 'Your plan changed since the style was made. Review the plan, or keep it as it is, before building.';
  if (!x.hasStyle) return 'Pick and lock your style first.';
  if (x.styleStale) return 'Your style is out of date. Review it, or keep it as it is, before building.';
  if (!x.styleLocked) return 'Lock your style first — the whole site is built in exactly that look.';
  return null;
}

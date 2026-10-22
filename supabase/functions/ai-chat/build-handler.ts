// FULL BUILD (REVAMP Step 10) — what ai-chat does for the build, with every side effect behind `BuildDeps` so the whole flow is
// unit-tested against an in-memory fake (supabase/tests/build_handler.test.ts).
//
// A build is a Cloudflare Workflow (cf-worker/workflow.ts) that calls the model once per page, in parallel. The Worker is a thin
// executor: it holds no prompt logic and never sees a page's text except to pass it on. ai-chat owns everything else, through these
// operations (all but `recheck` need the Worker's shared secret — index.ts checks it):
//
//   begin      the plan + locked style → the shared system block, one prompt per page, and the checklist rows (build_steps)
//   step_start a page (or repair) is about to be written: mark it running; refuses when the job was stopped or the user is out of credits
//   page_done  a page call finished: bill it, keep the page (or why it failed). `attempt` makes a repeated report harmless
//   verify     assemble the site from the pages so far, run the launch verifier, and — while rounds remain — return repair prompts
//   complete   assemble once more, commit every file in one statement, save the manifest and the launch report, close the job
//   fail       the build cannot go on: close the job (nothing is committed), mark what was left undone
//   recheck    (the owner, no AI) verify the site as it is saved now and save a fresh launch report
//
// Nothing is committed until `complete`, and `complete` refuses when a planned page was never built: a half-built site must never
// replace a working one. Pages the verifier still finds faults in after the repair rounds ARE committed — the report says so, the
// owner sees it, and the launch gate (Step 12) refuses a failing report.
import { normalizeArtifact, validateArtifact, type LaunchChecks, type Manifest, type Plan, type StyleSpec } from '../_shared/artifacts.ts';
import type { LatestArtifacts } from '../_shared/stages.ts';
import { MAX_BUILD_PAGES, navPages, planBuild, type BuildPage, type BuildSpec } from './build-plan.ts';
import { BUILD_PAGE_MAX_TOKENS, buildSystem, fixPrompt, pageFromReply, pagePrompt, type BuildContext } from './build-prompts.ts';
import { assembleSite, finishStylesheet } from './site-derive.ts';
import { takeCheckpoint } from './checkpoints.ts';
import type { JobRow, StageDeps } from './stage-handler.ts';
import { inputBlockers } from './stages.ts';
import { repairable, verifySite, type Problem, type VerifyResult } from './verifier.ts';

export type StepKind = 'prepare' | 'page' | 'fix' | 'verify' | 'save';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepRow {
  job_id: string;
  project_id: string;
  seq: number;
  kind: StepKind;
  file: string | null;
  label: string;
  status: StepStatus;
  attempt: number;
  detail: string | null;
  cost_cents: number;
  /** The page the model wrote (page and fix steps), kept until the build is committed. Never sent to a client. */
  output: string | null;
}
export type NewStep = Pick<StepRow, 'job_id' | 'project_id' | 'seq' | 'kind' | 'file' | 'label'> & Partial<Pick<StepRow, 'status' | 'detail'>>;
/** Rows for one bulk insert: PostgREST refuses rows whose keys differ ("All object keys must match"), so every row gets the same ones. */
export function stepInsertRows(steps: NewStep[]): Record<string, unknown>[] {
  return steps.map((s) => ({ job_id: s.job_id, project_id: s.project_id, seq: s.seq, kind: s.kind, file: s.file ?? null, label: s.label, status: s.status ?? 'pending', detail: s.detail ?? null }));
}
export type StepPatch = Partial<Pick<StepRow, 'status' | 'attempt' | 'detail' | 'cost_cents' | 'output'>> & { started?: boolean; finished?: boolean };

export interface Usage {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface BuildDeps extends Pick<StageDeps, 'getProjectAccess' | 'getLatestArtifacts' | 'getJob' | 'finishJob' | 'saveArtifact' | 'saveMessage' | 'usageGate' | 'snapshot'> {
  /** The Anthropic model id the pages are written with (the cost of a call depends on it). */
  modelId: string;
  /** projects.files as it is now: name → text (non-text values are left out). */
  getProjectFiles(projectId: string): Promise<Record<string, string>>;
  /** Every step of the job, `output` included, in seq order. */
  listSteps(jobId: string): Promise<StepRow[]>;
  /** Inserts rows that do not exist yet; a row with the same (job, seq) is left as it is. */
  insertSteps(steps: NewStep[]): Promise<void>;
  updateStep(jobId: string, seq: number, patch: StepPatch): Promise<void>;
  /** Charges the user's credits for one model call and returns what it cost, in cents, unrounded (accounting keeps the fraction). */
  bill(userId: string, usage: Usage, modelId: string): Promise<number>;
  /** commit_site_build as the platform: every file of the build + the stale pages to remove, atomically. */
  commitSite(projectId: string, files: Record<string, string>, remove: string[]): Promise<void>;
}

export interface BuildReply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (body: Record<string, unknown>, status = 200): BuildReply => ({ status, body });
const refuse = (status: number, code: string, error: string): BuildReply => ({ status, body: { error, code } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

export const SEQ_PREPARE = 0;
export const SEQ_VERIFY = 100;
export const SEQ_SAVE = 101;
/** Repair rounds after the first check. Every round costs model calls; two settle nearly everything the checks can find. */
export const MAX_REPAIR_ROUNDS = 2;
/** Most characters of repair instructions sent back in one verify reply. */
export const MAX_REPAIR_REPLY_CHARS = 450_000;
const pageSeq = (index: number): number => 1 + index;
const fixSeq = (round: number, index: number): number => 200 + (round - 1) * MAX_BUILD_PAGES + index;

const money = (n: number): number => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the model said about itself, as a short line for the checklist ("a page that came back empty" → the reason). */
function shortReason(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}

// ── the inputs of a build ─────────────────────────────────────────────────────────────────────────

export interface Inputs {
  plan: Plan;
  style: StyleSpec;
  versions: { plan: number; style_spec: number };
  spec: BuildSpec;
  files: Record<string, string>;
}

async function loadInputs(job: JobRow, deps: BuildDeps): Promise<Inputs | string> {
  if (!(await deps.getProjectAccess(job.project_id, job.user_id))) return 'You no longer have access to this project.';
  const latest = await deps.getLatestArtifacts(job.project_id);
  if (inputBlockers('build', latest).length > 0) return 'The plan or the style changed while this was starting. Lock your style and try again.';
  const files = await deps.getProjectFiles(job.project_id);
  return inputsFrom(latest, files);
}

export function inputsFrom(latest: LatestArtifacts, files: Record<string, string>): Inputs | string {
  const plan = latest.plan, style = latest.style_spec;
  if (!plan || !style) return 'The plan or the style is missing.';
  const p = validateArtifact('plan', normalizeArtifact(plan.data)), s = validateArtifact('style_spec', normalizeArtifact(style.data));
  if (!p.ok || !s.ok) return 'The plan or the style could not be read. Open the plan and save it again.';
  return { plan: p.value, style: s.value, versions: { plan: plan.version, style_spec: style.version }, spec: planBuild(p.value), files };
}

function contextFor(i: Inputs): BuildContext {
  const example = typeof i.files['index.html'] === 'string' && i.files['index.html'].trim() ? i.files['index.html'] : null;
  const images = Object.keys(i.files).filter((n) => !n.startsWith('_') && IMAGE.test(n)).sort();
  return { plan: i.plan, style: i.style, spec: i.spec, versions: i.versions, stylesCss: finishStylesheet(i.files['styles.css'] ?? '', i.style), example, images };
}

/** The job, if it is a FULL BUILD job. `running` is false once it was stopped, replaced or finished. */
async function buildJob(jobId: unknown, deps: BuildDeps): Promise<{ job: JobRow; running: boolean } | BuildReply> {
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return refuse(400, 'bad_job', 'job_id is required.');
  const job = await deps.getJob(jobId);
  if (!job || job.stage !== 'build') return refuse(404, 'not_found', 'Job not found.');
  return { job, running: job.status === 'running' };
}
const isReply = (x: unknown): x is BuildReply => !!x && typeof x === 'object' && 'status' in x && 'body' in x;
const closedReply = (): BuildReply => reply({ ok: false, closed: true, error: 'This build was stopped or replaced.' });

/** The page each file currently has: the newest finished write (a repair replaces the first draft), and why a page has none. */
function currentPages(steps: StepRow[], spec: BuildSpec): { html: Record<string, string>; errors: Record<string, string> } {
  const html: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const p of spec.pages) {
    const mine = steps.filter((s) => s.file === p.file && (s.kind === 'page' || s.kind === 'fix')).sort((a, b) => b.seq - a.seq);
    const written = mine.find((s) => s.status === 'done' && s.output);
    if (written) html[p.file] = written.output!;
    else errors[p.file] = shortReason(mine.find((s) => s.status === 'failed' && s.detail)?.detail ?? 'The page was never written.');
  }
  return { html, errors };
}

export function otherFileNames(files: Record<string, string>, spec: BuildSpec): string[] {
  const own = new Set([...spec.pages.map((p) => p.file), 'styles.css', 'site.js', 'manifest.json', '_backend']);
  return Object.keys(files).filter((n) => !own.has(n) && !n.startsWith('_'));
}

function runVerifier(i: Inputs, pages: { html: Record<string, string>; errors: Record<string, string> }) {
  const assembled = assembleSite({ plan: i.plan, spec: i.spec, style: i.style, projectFiles: i.files, pages: pages.html });
  const result = verifySite({ plan: i.plan, spec: i.spec, style: i.style, files: assembled.files, otherFiles: otherFileNames(i.files, i.spec), pageErrors: pages.errors });
  return { assembled, result };
}

// ── begin ─────────────────────────────────────────────────────────────────────────────────────────

export async function beginBuild(body: { job_id?: unknown }, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  if (!j.running) return closedReply();
  const { job } = j;

  const inputs = await loadInputs(job, deps);
  if (typeof inputs === 'string') {
    await deps.finishJob(job.id, { status: 'failed', error: inputs });
    return reply({ ok: false, error: inputs });
  }
  const ctx = contextFor(inputs);
  const note = job.prompt ?? undefined;

  // A repeated `begin` (the Workflow retried it after a lost answer) must not make a second checklist.
  const rows: NewStep[] = [
    { job_id: job.id, project_id: job.project_id, seq: SEQ_PREPARE, kind: 'prepare', file: null, label: 'Setting up your shared files', status: 'done', detail: `${plural(inputs.spec.pages.length, 'page')} planned` },
    ...inputs.spec.pages.map((p, n): NewStep => ({ job_id: job.id, project_id: job.project_id, seq: pageSeq(n), kind: 'page', file: p.file, label: `Building ${p.title}` })),
    { job_id: job.id, project_id: job.project_id, seq: SEQ_VERIFY, kind: 'verify', file: null, label: 'Checking links, forms and checkout' },
    { job_id: job.id, project_id: job.project_id, seq: SEQ_SAVE, kind: 'save', file: null, label: 'Saving your site' },
  ];
  await deps.insertSteps(rows);

  return reply({
    ok: true,
    model: deps.modelId,
    max_tokens: BUILD_PAGE_MAX_TOKENS,
    system: buildSystem(ctx),
    pages: inputs.spec.pages.map((p, n) => ({ seq: pageSeq(n), file: p.file, title: p.title, prompt: pagePrompt(ctx, p, note === undefined ? {} : { note }) })),
  });
}

// ── step_start / page_done ────────────────────────────────────────────────────────────────────────

export async function startStep(body: { job_id?: unknown; seq?: unknown }, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  if (!j.running) return closedReply();
  const step = await stepOf(j.job, body.seq, deps);
  if (isReply(step)) return step;
  if (step.kind !== 'page' && step.kind !== 'fix') return refuse(400, 'bad_step', 'That step is not a page.');
  // Credits can run out in the middle of a long build: stop instead of spending past the limit.
  const limit = await deps.usageGate(j.job.user_id);
  if (limit) return reply({ ok: false, stop: true, error: limit });
  await deps.updateStep(j.job.id, step.seq, { status: 'running', detail: null, started: true });
  return reply({ ok: true });
}

async function stepOf(job: JobRow, seq: unknown, deps: BuildDeps): Promise<StepRow | BuildReply> {
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return refuse(400, 'bad_step', 'seq is required.');
  const step = (await deps.listSteps(job.id)).find((s) => s.seq === seq);
  return step ?? refuse(404, 'not_found', 'Step not found.');
}

const MAX_TOKENS_REPORTED = 20_000_000;
function cleanUsage(raw: unknown): Usage | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_TOKENS_REPORTED) : 0);
  const usage = { in: n(u.in), out: n(u.out), cacheWrite: n(u.cacheWrite), cacheRead: n(u.cacheRead) };
  return usage.in + usage.out + usage.cacheWrite + usage.cacheRead > 0 ? usage : null;
}

export interface PageDoneRequest {
  job_id?: unknown;
  seq?: unknown;
  /** 1 for the first try at this page, 2 for the second… A report for a try already recorded changes nothing. */
  attempt?: unknown;
  usage?: unknown;
  /** The files the call wrote (completed `<file>` blocks). */
  files?: unknown;
  /** Why the call produced nothing (the model API failed, the stream was cut…). */
  error?: unknown;
}

export async function pageDone(body: PageDoneRequest, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  const step = await stepOf(j.job, body.seq, deps);
  if (isReply(step)) return step;
  if (step.kind !== 'page' && step.kind !== 'fix') return refuse(400, 'bad_step', 'That step is not a page.');
  const attempt = body.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > 10) return refuse(400, 'bad_attempt', 'attempt must be 1–10.');
  // The same try reported twice (a retried request): the first report already billed and saved it.
  if (step.attempt >= attempt) return reply({ ok: step.status === 'done', duplicate: true, ...(step.status === 'done' ? {} : { error: step.detail ?? 'The page failed.' }) });

  // Tokens spent are billed whatever became of the page — and whether or not the owner pressed Stop in the meantime.
  const usage = cleanUsage(body.usage);
  const cost = usage ? await deps.bill(j.job.user_id, usage, deps.modelId) : 0;
  const cost_cents = money(step.cost_cents + cost);

  if (!j.running) {
    await deps.updateStep(j.job.id, step.seq, { attempt, cost_cents, status: 'failed', detail: 'Stopped', finished: true });
    return closedReply();
  }

  let failure: string | null = null;
  let html = '';
  if (typeof body.error === 'string' && body.error) failure = body.error;
  else {
    const files = fileMap(body.files);
    if (typeof files === 'string') failure = files;
    else {
      const page = pageFromReply(step.file ?? '', files);
      if ('error' in page) failure = page.error;
      else html = page.html;
    }
  }
  if (failure !== null) {
    await deps.updateStep(j.job.id, step.seq, { attempt, cost_cents, status: 'failed', detail: shortReason(failure), finished: true });
    return reply({ ok: false, error: shortReason(failure) });
  }
  await deps.updateStep(j.job.id, step.seq, { attempt, cost_cents, status: 'done', detail: null, output: html, finished: true });
  return reply({ ok: true });
}

function fileMap(raw: unknown): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'The reply listed its files in a form that could not be read.';
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    if (typeof text !== 'string') return 'The reply held a file that was not text.';
    out[name] = text;
  }
  return out;
}

// ── verify ────────────────────────────────────────────────────────────────────────────────────────

function countProblems(result: VerifyResult): { fails: number; warns: number } {
  return { fails: result.problems.filter((p) => p.severity === 'fail').length, warns: result.problems.filter((p) => p.severity === 'warn').length };
}

function verdict(result: VerifyResult): string {
  const { fails, warns } = countProblems(result);
  if (fails === 0 && warns === 0) return 'All checks passed';
  const parts: string[] = [];
  if (fails) parts.push(`${plural(fails, 'problem')} found`);
  if (warns) parts.push(`${plural(warns, 'thing')} worth a look`);
  return parts.join(', ');
}

export async function verifyBuild(body: { job_id?: unknown; round?: unknown }, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  if (!j.running) return closedReply();
  const round = typeof body.round === 'number' && Number.isInteger(body.round) && body.round >= 1 && body.round <= 50 ? body.round : 1;
  const { job } = j;

  const inputs = await loadInputs(job, deps);
  if (typeof inputs === 'string') {
    await deps.finishJob(job.id, { status: 'failed', error: inputs });
    return reply({ ok: false, error: inputs });
  }
  const steps = await deps.listSteps(job.id);
  const pages = currentPages(steps, inputs.spec);
  const { result } = runVerifier(inputs, pages);

  const groups = round <= MAX_REPAIR_ROUNDS ? repairable(result, inputs.spec) : new Map<string, Problem[]>();
  const ctx = contextFor(inputs);
  const note = job.prompt ?? undefined;
  const repairs: { seq: number; file: string; title: string; prompt: string }[] = [];
  const rows: NewStep[] = [];
  let budget = MAX_REPAIR_REPLY_CHARS;
  inputs.spec.pages.forEach((p: BuildPage, n) => {
    const problems = groups.get(p.file);
    if (!problems) return;
    const prompt = fixPrompt(ctx, p, pages.html[p.file] ?? null, problems, note === undefined ? {} : { note });
    // The reply is stored by the Workflow as one step result (1 MiB at most). A page left out here is checked again in the next round.
    if (repairs.length > 0 && prompt.length > budget) return;
    budget -= prompt.length;
    const seq = fixSeq(round, n);
    rows.push({ job_id: job.id, project_id: job.project_id, seq, kind: 'fix', file: p.file, label: `Fixing ${p.title}` });
    repairs.push({ seq, file: p.file, title: p.title, prompt });
  });
  if (rows.length) await deps.insertSteps(rows);

  const final = repairs.length === 0;
  await deps.updateStep(job.id, SEQ_VERIFY, {
    status: final ? 'done' : 'running',
    detail: final ? verdict(result) : `${verdict(result)} — repairing ${plural(repairs.length, 'page')}`,
    started: true,
    finished: final,
  });
  const { fails, warns } = countProblems(result);
  return reply({ ok: true, final, site_ok: result.ok, fails, warns, repairs });
}

// ── complete / fail ───────────────────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

/** The one or two plain sentences that tell the owner how the build went (the stage chat shows it). */
export function buildSummary(pageCount: number, result: VerifyResult): string {
  const { fails, warns } = countProblems(result);
  const head = `Your site is built — ${plural(pageCount, 'page')}.`;
  const open = result.open_items.length ? ` Still needed from you: ${result.open_items.slice(0, 4).join('; ')}${result.open_items.length > 4 ? '…' : ''}.` : '';
  if (fails === 0 && warns === 0) return `${head} Every check passed.${open}`;
  if (fails === 0) return `${head} Everything works; ${plural(warns, 'thing')} ${warns === 1 ? 'is' : 'are'} worth a look in the report.${open}`;
  const first = result.problems.filter((p) => p.severity === 'fail').slice(0, 2).map((p) => `${p.file}: ${p.message.replace(/\.$/, '')}`).join('; ');
  return `${head} ${plural(fails, 'problem')} could not be fixed automatically and ${fails === 1 ? 'needs' : 'need'} your attention — ${first}. You can build again or fix it in Tweaks.${open}`;
}

export function manifestFor(plan: Plan, spec: BuildSpec, backend: Manifest['backend'], costCents: number): Manifest {
  const inNav = new Set(navPages(spec).map((p) => p.file));
  return {
    schema: 1,
    built_at: isoNow(),
    pages: spec.pages.map((p) => ({ file: p.file, title: p.title, in_nav: inNav.has(p.file) })),
    shared_files: ['styles.css', 'site.js'],
    backend,
    cost_cents: costCents,
  };
}

export function launchChecksFor(result: VerifyResult, manifestVersion: number): LaunchChecks {
  return { schema: 1, checked_at: isoNow(), manifest_version: manifestVersion, ok: result.ok, checks: result.checks, open_items: result.open_items };
}

export async function completeBuild(body: { job_id?: unknown }, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  if (j.job.status === 'complete') return reply({ ok: true, duplicate: true });
  if (!j.running) return closedReply();
  const { job } = j;
  const failBuild = async (error: string): Promise<BuildReply> => {
    await deps.updateStep(job.id, SEQ_SAVE, { status: 'failed', detail: shortReason(error), started: true, finished: true });
    await deps.finishJob(job.id, { status: 'failed', error });
    return reply({ ok: false, error });
  };

  const inputs = await loadInputs(job, deps);
  if (typeof inputs === 'string') return failBuild(inputs);
  const steps = await deps.listSteps(job.id);
  const pages = currentPages(steps, inputs.spec);

  const missing = inputs.spec.pages.filter((p) => pages.html[p.file] === undefined).map((p) => p.file);
  if (missing.length > 0) {
    const error = `${plural(missing.length, 'page')} could not be built (${missing.join(', ')}). Nothing was changed — please try again.`;
    return failBuild(error);
  }

  await deps.updateStep(job.id, SEQ_SAVE, { status: 'running', detail: null, started: true });
  const { assembled, result } = runVerifier(inputs, pages);
  const cost = money(steps.reduce((sum, s) => sum + s.cost_cents, 0));
  const manifest = manifestFor(inputs.plan, inputs.spec, assembled.backendSummary, cost);
  const m = validateArtifact('manifest', normalizeArtifact(manifest));
  if (!m.ok) return failBuild(`The site's summary could not be saved (${m.errors.slice(0, 2).join('; ')}).`);

  let manifestVersion: number;
  try {
    // Files first, then the manifest, then the report: a new manifest version is what tells the studio "the build is done".
    await deps.commitSite(job.project_id, assembled.files, assembled.remove);
    await takeCheckpoint(deps, job.project_id, 'stage', 'Full build');
    manifestVersion = (await deps.saveArtifact(job.project_id, 'manifest', m.value as unknown as Record<string, unknown>)).version;
    const checks = launchChecksFor(result, manifestVersion);
    const c = validateArtifact('launch_checks', normalizeArtifact(checks));
    if (!c.ok) throw new Error(`launch report invalid: ${c.errors.slice(0, 2).join('; ')}`);
    await deps.saveArtifact(job.project_id, 'launch_checks', c.value as unknown as Record<string, unknown>);
  } catch (e) {
    return failBuild(`The site could not be saved. Please try again. (${e instanceof Error ? e.message : String(e)})`.slice(0, 500));
  }

  const summary = buildSummary(inputs.spec.pages.length, result);
  try {
    await deps.saveMessage({ project_id: job.project_id, stage: 'build', role: 'assistant', content: summary, user_id: null, job_id: job.id });
  } catch (e) {
    console.error('[ai-chat] could not save the build summary', e);
  }
  await deps.updateStep(job.id, SEQ_SAVE, { status: 'done', detail: plural(Object.keys(assembled.files).length, 'file') + ' saved', finished: true });
  await deps.finishJob(job.id, { status: 'complete' });
  return reply({ ok: true, manifest_version: manifestVersion, site_ok: result.ok, cost_cents: cost, summary });
}

export async function failBuildJob(body: { job_id?: unknown; error?: unknown }, deps: BuildDeps): Promise<BuildReply> {
  const j = await buildJob(body.job_id, deps);
  if (isReply(j)) return j;
  if (!j.running) return reply({ ok: true, closed: true });
  const error = typeof body.error === 'string' && body.error.trim() ? shortReason(body.error) : 'The build did not finish.';
  for (const s of await deps.listSteps(j.job.id)) {
    if (s.status === 'pending') await deps.updateStep(j.job.id, s.seq, { status: 'skipped' });
    else if (s.status === 'running') await deps.updateStep(j.job.id, s.seq, { status: 'failed', detail: 'Interrupted', finished: true });
  }
  await deps.finishJob(j.job.id, { status: 'failed', error });
  return reply({ ok: true });
}

// ── recheck ───────────────────────────────────────────────────────────────────────────────────────

/**
 * "Check again": the owner's request (their own login, no AI, no cost) to verify the site exactly as it is saved now — after they
 * added photos, edited a page by hand or changed the plan — and save a fresh launch report for the current manifest.
 */
export async function recheckSite(body: { project_id?: unknown }, userId: string, deps: Pick<BuildDeps, 'getProjectAccess' | 'getLatestArtifacts' | 'getProjectFiles' | 'saveArtifact'>): Promise<BuildReply> {
  if (typeof body.project_id !== 'string' || !body.project_id || body.project_id.length > 200) return refuse(400, 'bad_project', 'project_id is required.');
  const projectId = body.project_id;
  if (!(await deps.getProjectAccess(projectId, userId))) return refuse(404, 'not_found', 'Project not found.');
  const latest = await deps.getLatestArtifacts(projectId);
  const manifest = latest.manifest;
  if (!manifest) return refuse(409, 'stage_inputs', 'Needs the built site first.');
  const files = await deps.getProjectFiles(projectId);
  const inputs = inputsFrom(latest, files);
  if (typeof inputs === 'string') return refuse(409, 'stage_inputs', inputs);

  const result = verifyStored(inputs, files);
  const saved = await saveLaunchReport(deps, projectId, result, manifest.version);
  if (typeof saved === 'string') return refuse(500, 'check_failed', saved);
  return reply({ ok: true, version: saved, site_ok: result.ok, ...countProblems(result) });
}

/** The verifier's verdict on the site exactly as it is saved: its pages, styles.css, site.js, manifest.json and `_backend`. */
export function verifyStored(inputs: Inputs, files: Record<string, string>): VerifyResult {
  const published: Record<string, string> = {};
  for (const n of [...inputs.spec.pages.map((p) => p.file), 'styles.css', 'site.js', 'manifest.json', '_backend']) if (typeof files[n] === 'string') published[n] = files[n]!;
  return verifySite({ plan: inputs.plan, spec: inputs.spec, style: inputs.style, files: published, otherFiles: otherFileNames(files, inputs.spec) });
}

/** Saves a new launch report for `manifestVersion`; its version, or why it could not be saved. */
export async function saveLaunchReport(deps: Pick<BuildDeps, 'saveArtifact'>, projectId: string, result: VerifyResult, manifestVersion: number): Promise<number | string> {
  const c = validateArtifact('launch_checks', normalizeArtifact(launchChecksFor(result, manifestVersion)));
  if (!c.ok) return 'The report could not be saved.';
  return (await deps.saveArtifact(projectId, 'launch_checks', c.value as unknown as Record<string, unknown>)).version;
}

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────────

export type BuildOp = 'begin' | 'step_start' | 'page_done' | 'verify' | 'complete' | 'fail';

/** The Worker's operations. The caller has already checked the Worker's secret. */
export async function runBuildOp(body: Record<string, unknown>, deps: BuildDeps): Promise<BuildReply> {
  switch (body.op) {
    case 'begin': return await beginBuild(body, deps);
    case 'step_start': return await startStep(body, deps);
    case 'page_done': return await pageDone(body, deps);
    case 'verify': return await verifyBuild(body, deps);
    case 'complete': return await completeBuild(body, deps);
    case 'fail': return await failBuildJob(body, deps);
    default: return refuse(400, 'bad_op', 'Unknown build operation.');
  }
}

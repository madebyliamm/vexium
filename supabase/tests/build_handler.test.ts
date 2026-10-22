// FULL BUILD server side — run:  node --test supabase/tests/build_handler.test.ts
// The real handler (build-handler.ts), planner, assembler and verifier against an in-memory BuildDeps; the "model" is the test, which
// answers each page with a canned reply. A build must never commit half a site, never bill twice for one report, and never let a
// stopped build write.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../functions/_shared/artifacts.ts';
import { applyPut, type ArtifactKind, type LatestArtifacts } from '../functions/_shared/stages.ts';
import { completeBuild, failBuildJob, MAX_REPAIR_ROUNDS, pageDone, recheckSite, runBuildOp, SEQ_SAVE, SEQ_VERIFY, startStep, stepInsertRows, verifyBuild, beginBuild, type BuildDeps, type NewStep, type StepPatch, type StepRow, type Usage } from '../functions/ai-chat/build-handler.ts';
import { beginStage, isHttpError, type JobRow } from '../functions/ai-chat/stage-handler.ts';
import { CONTACT, EXAMPLE_CSS, HOME, SHOP, STYLE, wrap } from './site_fixtures.ts';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = 'proj_1';

const PLAN: Plan = {
  ...emptyPlan('Wick & Co'),
  one_liner: 'Hand-poured candles',
  pages: [{ file: 'index.html', title: 'Home', purpose: 'Introduce the candles' }, { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' }, { file: 'contact.html', title: 'Contact', purpose: 'Get in touch' }],
  pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2400 }] },
  backend: { collections: [], products: ['candle'], forms: ['contact'], auth: false },
  launch_checklist: [{ id: 'photos', label: 'Real product photos', type: 'photo', done: false }],
};

const PAGES: Record<string, string> = { 'index.html': HOME, 'shop.html': SHOP, 'contact.html': CONTACT };
const LOREM = wrap('Shop', `<section><h1>Shop</h1><article><h2>Amber candle</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><p class="price">$24</p><button data-vx-buy="candle">Buy now</button></article></section>`);
const USAGE: Usage = { in: 1000, out: 10_000, cacheWrite: 0, cacheRead: 30_000 };
// What the fake bills: a flat 0.0015 ¢ per output token, 0.0003 per input token (fractions kept, like the real accounting).
const costOf = (u: Usage): number => u.out * 0.0015 + u.in * 0.0003;

interface World {
  deps: BuildDeps;
  latest: LatestArtifacts;
  jobs: Map<string, JobRow>;
  steps: StepRow[];
  files: Record<string, string>;
  commits: { files: Record<string, string>; remove: string[] }[];
  snapshots: { kind: string; label: string }[];
  saved: { kind: ArtifactKind; data: Record<string, unknown> }[];
  billed: { user: string; usage: Usage; model: string }[];
  chat: { stage: string; role: string; content: string }[];
  state: { credits: string | null; access: boolean; commitFails: boolean };
  jobId: string;
}

function world(over: { plan?: Plan; locked?: boolean; note?: string } = {}): World {
  const latest = [['plan', over.plan ?? PLAN], ['style_spec', { ...STYLE, locked: over.locked ?? true }]].reduce((l, [k, d]) => applyPut(l, k as ArtifactKind, d as Record<string, unknown>).latest, {} as LatestArtifacts);
  const w: World = {
    latest, jobs: new Map(), steps: [], files: { 'index.html': '<html><body>the approved example</body></html>', 'styles.css': EXAMPLE_CSS, 'site.js': '', 'logo.png': 'x', 'old.html': '<html><body>an old page</body></html>' },
    commits: [], snapshots: [], saved: [], billed: [], chat: [], state: { credits: null, access: true, commitFails: false }, jobId: '', deps: undefined as unknown as BuildDeps,
  };
  w.jobId = '00000000-0000-4000-8000-000000000001';
  w.jobs.set(w.jobId, { id: w.jobId, project_id: PROJECT, user_id: OWNER, stage: 'build', status: 'running', prompt: over.note ?? 'Build my site' });
  w.deps = {
    modelId: 'claude-sonnet-4-6',
    async getProjectAccess() { return w.state.access ? { name: 'Wick & Co', stage: 'build' } : null; },
    async getLatestArtifacts() { return w.latest; },
    async usageGate() { return w.state.credits; },
    async getJob(id) { return w.jobs.get(id) ?? null; },
    async finishJob(id, patch) { const j = w.jobs.get(id); if (j && j.status === 'running') Object.assign(j, patch); },
    async saveArtifact(_p, kind, data) { const r = applyPut(w.latest, kind, data); w.latest = r.latest; w.saved.push({ kind, data }); return { version: r.version, staled: r.staled }; },
    async saveMessage(m) { w.chat.push(m); },
    async getProjectFiles() { return { ...w.files }; },
    async snapshot(_p, kind, label) { w.snapshots.push({ kind, label }); return { seq: w.snapshots.length, created: true }; },
    async listSteps(jobId) { return w.steps.filter((s) => s.job_id === jobId).sort((a, b) => a.seq - b.seq).map((s) => ({ ...s })); },
    async insertSteps(rows: NewStep[]) {
      for (const r of rows) {
        if (w.steps.some((s) => s.job_id === r.job_id && s.seq === r.seq)) continue;
        w.steps.push({ ...r, status: r.status ?? 'pending', detail: r.detail ?? null, attempt: 0, cost_cents: 0, output: null });
      }
    },
    async updateStep(jobId: string, seq: number, patch: StepPatch) {
      const s = w.steps.find((x) => x.job_id === jobId && x.seq === seq)!;
      const { started: _s, finished: _f, ...rest } = patch;
      Object.assign(s, rest);
    },
    async bill(user, usage, model) { w.billed.push({ user, usage, model }); return costOf(usage); },
    async commitSite(_p, files, remove) {
      if (w.state.commitFails) throw new Error('commit_site_build exploded');
      w.commits.push({ files, remove });
      w.files = { ...w.files, ...files };
      for (const r of remove) delete w.files[r];
    },
  };
  return w;
}

const seqOf = (w: World, file: string, kind = 'page') => w.steps.find((s) => s.file === file && s.kind === kind)!.seq;
/** The "model" writes `html` as the page and the Worker reports it. */
async function write(w: World, file: string, html: string, attempt = 1, seq = seqOf(w, file), usage: Usage | undefined = USAGE) {
  return await pageDone({ job_id: w.jobId, seq, attempt, usage, files: { [file]: html } }, w.deps);
}
async function writeAll(w: World, pages: Record<string, string> = PAGES) {
  for (const [file, html] of Object.entries(pages)) assert.equal((await write(w, file, html)).body.ok, true, file);
}
const body = (r: { body: Record<string, unknown> }) => r.body;

describe('beginStage for the build', () => {
  it('creates the job and records the owner\'s line, but prepares no prompt — the Worker is told which job to run', async () => {
    const w = world();
    const jobs = new Map<string, JobRow & { artifact_kind?: string | null }>();
    const chat: unknown[] = [];
    const run = await beginStage({ stage: 'build', project_id: PROJECT, messages: [{ role: 'user', content: 'Make it warmer' }] }, OWNER, {
      ...w.deps,
      async createJob(j) { jobs.set('j1', { id: 'j1', ...j, status: 'running', stage: j.stage }); return 'j1'; },
      async saveFiles() {},
      async lastMessage() { return null; },
      async saveMessage(m) { chat.push(m); },
    });
    assert.ok(!isHttpError(run));
    assert.deepEqual(run, { kind: 'workflow', stage: 'build', jobId: 'j1' });
    assert.equal(jobs.get('j1')!.artifact_kind, 'manifest');
    assert.equal(jobs.get('j1')!.prompt, 'Make it warmer');
    assert.equal(chat.length, 1);
  });
  it('still refuses an unlocked style', async () => {
    const w = world({ locked: false });
    const r = await beginStage({ stage: 'build', project_id: PROJECT, messages: [{ role: 'user', content: 'Build my site' }] }, OWNER, { ...w.deps, async createJob() { return 'x'; }, async saveFiles() {}, async lastMessage() { return null; } });
    assert.ok(isHttpError(r) && r.status === 409 && /Lock your style first/.test(r.body.error));
  });
});

describe('begin', () => {
  it('returns one shared system block and one prompt per page, and lays out the checklist', async () => {
    const w = world();
    const r = body(await beginBuild({ job_id: w.jobId }, w.deps));
    assert.equal(r.ok, true);
    assert.equal(r.model, 'claude-sonnet-4-6');
    const pages = r.pages as { seq: number; file: string; title: string; prompt: string }[];
    assert.deepEqual(pages.map((p) => [p.seq, p.file]), [[1, 'index.html'], [2, 'shop.html'], [3, 'contact.html']]);
    assert.match(r.system as string, /### plan \(version 1\)/);
    assert.match(r.system as string, /### style_spec \(version 1, locked\)/);
    assert.match(r.system as string, /the approved example/);
    assert.match(pages[1]!.prompt, /PAGE TO BUILD: shop\.html/);
    assert.ok(!(r.system as string).includes('PAGE TO BUILD:'), 'nothing page-specific in the cached block');
    assert.deepEqual(w.steps.map((s) => [s.seq, s.kind, s.status]), [[0, 'prepare', 'done'], [1, 'page', 'pending'], [2, 'page', 'pending'], [3, 'page', 'pending'], [SEQ_VERIFY, 'verify', 'pending'], [SEQ_SAVE, 'save', 'pending']]);
    assert.equal(w.steps[1]!.label, 'Building Home');
  });
  it('is harmless to repeat, and passes the owner\'s note to every page', async () => {
    const w = world({ note: 'Make the whole site warmer.' });
    const a = body(await beginBuild({ job_id: w.jobId }, w.deps));
    const b = body(await beginBuild({ job_id: w.jobId }, w.deps));
    assert.equal(w.steps.length, 6);
    assert.equal(a.system, b.system);
    for (const p of a.pages as { prompt: string }[]) assert.match(p.prompt, /OWNER'S NOTE[^\n]*\nMake the whole site warmer\./);
  });
  it('fails the job when the style was unlocked or the plan changed while the build was starting', async () => {
    const w = world();
    w.latest = applyPut(w.latest, 'plan', { ...PLAN, name: 'Renamed' }).latest; // a new plan stales the style
    const r = body(await beginBuild({ job_id: w.jobId }, w.deps));
    assert.equal(r.ok, false);
    assert.match(r.error as string, /changed while this was starting/);
    assert.equal(w.jobs.get(w.jobId)!.status, 'failed');
    assert.equal(w.steps.length, 0);
  });
  it('fails the job when access was removed', async () => {
    const w = world();
    w.state.access = false;
    assert.equal(body(await beginBuild({ job_id: w.jobId }, w.deps)).ok, false);
    assert.equal(w.jobs.get(w.jobId)!.status, 'failed');
  });
  it('refuses a bad id, a job that is not a build, and a closed job', async () => {
    const w = world();
    assert.equal((await beginBuild({ job_id: 'nope' }, w.deps)).status, 400);
    assert.equal((await beginBuild({ job_id: '00000000-0000-4000-8000-0000000000ff' }, w.deps)).status, 404);
    w.jobs.get(w.jobId)!.stage = 'example';
    assert.equal((await beginBuild({ job_id: w.jobId }, w.deps)).status, 404);
    w.jobs.get(w.jobId)!.stage = 'build';
    w.jobs.get(w.jobId)!.status = 'failed';
    assert.equal(body(await beginBuild({ job_id: w.jobId }, w.deps)).closed, true);
  });
});

describe('a build from start to finish', () => {
  it('builds, verifies, commits every file at once, saves the manifest then the report, and closes the job', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    for (const seq of [1, 2, 3]) assert.equal(body(await startStep({ job_id: w.jobId, seq }, w.deps)).ok, true);
    assert.deepEqual(w.steps.slice(1, 4).map((s) => s.status), ['running', 'running', 'running']);
    await writeAll(w);
    assert.deepEqual(w.steps.slice(1, 4).map((s) => s.status), ['done', 'done', 'done']);

    const v = body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps));
    assert.deepEqual({ ok: v.ok, final: v.final, site_ok: v.site_ok, fails: v.fails, repairs: v.repairs }, { ok: true, final: true, site_ok: true, fails: 0, repairs: [] });
    assert.equal(w.steps.find((s) => s.seq === SEQ_VERIFY)!.status, 'done');

    const c = body(await completeBuild({ job_id: w.jobId }, w.deps));
    assert.equal(c.ok, true);
    assert.equal(c.site_ok, true);
    assert.equal(w.commits.length, 1, 'one atomic commit');
    const { files, remove } = w.commits[0]!;
    assert.deepEqual(Object.keys(files).sort(), ['_backend', 'contact.html', 'index.html', 'manifest.json', 'shop.html', 'site.js', 'styles.css']);
    assert.deepEqual(remove, ['old.html'], 'the page the plan no longer has is removed with the commit');
    assert.match(files['styles.css']!, /--accent: #b4532a/, 'the locked style is written into the stylesheet');
    assert.deepEqual(JSON.parse(files['_backend']!).products, [{ id: 'candle', name: 'candle', price_cents: 2400 }]);

    assert.deepEqual(w.saved.map((s) => s.kind), ['manifest', 'launch_checks'], 'manifest first: its new version is the "build is done" signal');
    const manifest = w.saved[0]!.data as { pages: { file: string; in_nav?: boolean }[]; shared_files: string[]; backend: { products: string[]; forms: string[] }; cost_cents: number };
    assert.deepEqual(manifest.pages.map((p) => p.file), ['index.html', 'shop.html', 'contact.html']);
    assert.deepEqual(manifest.backend.products, ['candle']);
    assert.deepEqual(manifest.backend.forms, ['contact']);
    assert.deepEqual(manifest.shared_files, ['styles.css', 'site.js']);
    const report = w.saved[1]!.data as { ok: boolean; manifest_version: number; open_items: string[] };
    assert.equal(report.ok, true);
    assert.equal(report.manifest_version, 1);
    assert.deepEqual(report.open_items, ['Real product photos']);

    assert.equal(w.jobs.get(w.jobId)!.status, 'complete');
    assert.equal(w.steps.find((s) => s.seq === SEQ_SAVE)!.status, 'done');
    assert.deepEqual(w.chat.map((m) => [m.stage, m.role]), [['build', 'assistant']]);
    assert.match(w.chat[0]!.content, /Your site is built — 3 pages\. Every check passed\. Still needed from you: Real product photos\./);
  });

  it('accounts for what the build cost: every page billed to the owner, the sum kept on the steps and the manifest', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w);
    await completeBuild({ job_id: w.jobId }, w.deps);
    assert.equal(w.billed.length, 3);
    assert.ok(w.billed.every((b) => b.user === OWNER && b.model === 'claude-sonnet-4-6'));
    const each = Math.round(costOf(USAGE) * 100) / 100;
    assert.deepEqual(w.steps.filter((s) => s.kind === 'page').map((s) => s.cost_cents), [each, each, each]);
    assert.equal((w.saved[0]!.data as { cost_cents: number }).cost_cents, Math.round(each * 3 * 100) / 100);
  });

  it('keeps other files of the project (images, memory) — only the build\'s own files are written', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w);
    await completeBuild({ job_id: w.jobId }, w.deps);
    assert.equal(w.files['logo.png'], 'x');
    assert.equal(w.files['old.html'], undefined);
    assert.match(w.files['index.html']!, /Candles poured by hand/);
  });
});

describe('repair rounds', () => {
  it('sends a page the verifier faults back to the model with the problems, and uses the repaired page', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w, { ...PAGES, 'shop.html': LOREM });
    const v = body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)) as { final: boolean; site_ok: boolean; repairs: { seq: number; file: string; prompt: string }[] };
    assert.equal(v.final, false);
    assert.equal(v.site_ok, false);
    assert.equal(v.repairs.length, 1);
    assert.equal(v.repairs[0]!.file, 'shop.html');
    assert.ok(v.repairs[0]!.seq >= 200);
    assert.match(v.repairs[0]!.prompt, /REPAIR/);
    assert.match(v.repairs[0]!.prompt, /lorem ipsum/i);
    assert.match(v.repairs[0]!.prompt, /Lorem ipsum dolor sit amet/, 'the page as it is now is included');
    assert.equal(w.steps.find((s) => s.seq === SEQ_VERIFY)!.status, 'running');
    assert.deepEqual(w.steps.filter((s) => s.kind === 'fix').map((s) => [s.file, s.label, s.status]), [['shop.html', 'Fixing Shop', 'pending']]);

    // asking again (a retried request) does not make a second fix row
    await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps);
    assert.equal(w.steps.filter((s) => s.kind === 'fix').length, 1);

    assert.equal(body(await startStep({ job_id: w.jobId, seq: v.repairs[0]!.seq }, w.deps)).ok, true);
    assert.equal(body(await write(w, 'shop.html', SHOP, 1, v.repairs[0]!.seq)).ok, true);
    const v2 = body(await verifyBuild({ job_id: w.jobId, round: 2 }, w.deps));
    assert.deepEqual({ final: v2.final, site_ok: v2.site_ok, repairs: v2.repairs }, { final: true, site_ok: true, repairs: [] });
    await completeBuild({ job_id: w.jobId }, w.deps);
    assert.match(w.commits[0]!.files['shop.html']!, /Warm amber and cedar/);
    assert.doesNotMatch(w.commits[0]!.files['shop.html']!, /Lorem/);
    assert.equal((w.saved[1]!.data as { ok: boolean }).ok, true);
  });

  it('a repair that fails leaves the page as it was; after the last round the site is committed with an honest report', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w, { ...PAGES, 'shop.html': LOREM });
    let repairs = (body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)).repairs as { seq: number }[]);
    assert.equal(body(await pageDone({ job_id: w.jobId, seq: repairs[0]!.seq, attempt: 1, error: 'overloaded' }, w.deps)).ok, false);
    repairs = body(await verifyBuild({ job_id: w.jobId, round: MAX_REPAIR_ROUNDS, }, w.deps)).repairs as { seq: number }[];
    assert.equal(repairs.length, 1, 'the second round still repairs');
    const last = body(await verifyBuild({ job_id: w.jobId, round: MAX_REPAIR_ROUNDS + 1 }, w.deps));
    assert.deepEqual({ final: last.final, site_ok: last.site_ok, repairs: last.repairs }, { final: true, site_ok: false, repairs: [] });
    const c = body(await completeBuild({ job_id: w.jobId }, w.deps));
    assert.equal(c.ok, true);
    assert.equal(c.site_ok, false);
    assert.match(w.commits[0]!.files['shop.html']!, /Lorem ipsum/, 'the page the model could not fix is still the one saved');
    const report = w.saved[1]!.data as { ok: boolean; checks: { id: string; status: string }[] };
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.id === 'content')!.status, 'fail');
    assert.match(w.chat[0]!.content, /1 problem could not be fixed automatically and needs your attention — shop\.html: .*lorem/i);
  });
});

describe('a verify reply stays small enough for a Workflow step', () => {
  it('repairs that would not fit in one reply wait for the next round; none is lost', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ file: i === 0 ? 'index.html' : `page${i}.html`, title: i === 0 ? 'Home' : `Page ${i}`, purpose: `Tell visitors about thing ${i}` }));
    const w = world({ plan: { ...PLAN, pages, pricing: { model: 'free', items: [] }, backend: { collections: [], products: [], forms: [], auth: false } } });
    await beginBuild({ job_id: w.jobId }, w.deps);
    const filler = '<p>A real sentence about hand-poured candles, repeated to make the page large.</p>'.repeat(2000);
    const broken = (title: string) => wrap(title, `<section><h1>${title}</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>${filler}</section>`);
    await writeAll(w, Object.fromEntries(pages.map((p) => [p.file, broken(p.title)])));
    const r1 = body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)).repairs as { seq: number; file: string; prompt: string }[];
    assert.ok(r1.length >= 1 && r1.length < 6, `round 1 repairs ${r1.length} of 6`);
    assert.ok(JSON.stringify(r1).length < 700_000, 'well under a Workflow step\'s 1 MiB');
    for (const r of r1) assert.equal((await write(w, r.file, wrap(r.file, `<section><h1>${r.file}</h1><p>Real words about candles and how they are made by hand.</p>${'<p>Real words about candles.</p>'.repeat(5)}</section>`), 1, r.seq)).body.ok, true);
    const r2 = body(await verifyBuild({ job_id: w.jobId, round: 2 }, w.deps)).repairs as { file: string }[];
    assert.ok(r2.length >= 1, 'the pages left out are repaired in the next round');
    assert.ok(r2.every((r) => !r1.some((x) => x.file === r.file)));
  });
});

describe('pages that fail', () => {
  it('a failed try keeps its reason on the checklist; the next try can still succeed', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    const bad = body(await pageDone({ job_id: w.jobId, seq: 2, attempt: 1, usage: USAGE, error: 'The AI service had a problem.' }, w.deps));
    assert.deepEqual({ ok: bad.ok, error: bad.error }, { ok: false, error: 'The AI service had a problem.' });
    assert.deepEqual([w.steps[2]!.status, w.steps[2]!.detail, w.steps[2]!.attempt], ['failed', 'The AI service had a problem.', 1]);
    assert.equal(w.billed.length, 1, 'a failed try is still billed — the tokens were spent');
    await startStep({ job_id: w.jobId, seq: 2 }, w.deps);
    assert.equal(w.steps[2]!.status, 'running');
    assert.equal(w.steps[2]!.detail, null);
    assert.equal(body(await write(w, 'shop.html', SHOP, 2)).ok, true);
    assert.deepEqual([w.steps[2]!.status, w.steps[2]!.attempt, w.steps[2]!.cost_cents], ['done', 2, Math.round(costOf(USAGE) * 2 * 100) / 100]);
  });
  it('a reply that did not write the page, or wrote an empty one, is a failed try', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    const other = body(await pageDone({ job_id: w.jobId, seq: 2, attempt: 1, files: { 'about.html': SHOP } }, w.deps));
    assert.match(other.error as string, /did not write shop\.html/);
    const tiny = body(await pageDone({ job_id: w.jobId, seq: 2, attempt: 2, files: { 'shop.html': '<html></html>' } }, w.deps));
    assert.match(tiny.error as string, /empty/);
    assert.equal(w.steps[2]!.output, null);
    assert.equal(body(await pageDone({ job_id: w.jobId, seq: 2, attempt: 3, files: 'nope' }, w.deps)).ok, false);
    assert.equal(body(await pageDone({ job_id: w.jobId, seq: 2, attempt: 4, files: { 'shop.html': 5 } }, w.deps)).ok, false);
  });
  it('the same report twice bills once and changes nothing', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await write(w, 'shop.html', SHOP);
    const again = body(await write(w, 'shop.html', LOREM));
    assert.deepEqual(again, { ok: true, duplicate: true });
    assert.equal(w.billed.length, 1);
    assert.match(w.steps[2]!.output!, /Warm amber/, 'the first report stands');
    await pageDone({ job_id: w.jobId, seq: 1, attempt: 1, error: 'x' }, w.deps);
    const dup = body(await pageDone({ job_id: w.jobId, seq: 1, attempt: 1, error: 'x' }, w.deps));
    assert.deepEqual([dup.ok, dup.duplicate, dup.error], [false, true, 'x']);
  });
  it('refuses to commit when a planned page was never built — a half-built site must not replace a working one', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w, { 'index.html': HOME, 'shop.html': SHOP });
    await pageDone({ job_id: w.jobId, seq: 3, attempt: 1, error: 'The AI stopped before finishing.' }, w.deps);
    const v = body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)) as { repairs: { file: string; prompt: string }[] };
    assert.equal(v.repairs[0]!.file, 'contact.html');
    assert.match(v.repairs[0]!.prompt, /nothing to repair: write the whole page afresh/);
    assert.match(v.repairs[0]!.prompt, /The AI stopped before finishing/);
    const c = body(await completeBuild({ job_id: w.jobId }, w.deps));
    assert.equal(c.ok, false);
    assert.match(c.error as string, /1 page could not be built \(contact\.html\)\. Nothing was changed/);
    assert.equal(w.commits.length, 0);
    assert.equal(w.saved.length, 0);
    assert.equal(w.files['old.html'] !== undefined, true);
    assert.equal(w.jobs.get(w.jobId)!.status, 'failed');
    assert.equal(w.steps.find((s) => s.seq === SEQ_SAVE)!.status, 'failed');
  });
  it('a repair can supply a page that had failed outright', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w, { 'index.html': HOME, 'shop.html': SHOP });
    await pageDone({ job_id: w.jobId, seq: 3, attempt: 1, error: 'cut' }, w.deps);
    const v = body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)) as { repairs: { seq: number }[] };
    await write(w, 'contact.html', CONTACT, 1, v.repairs[0]!.seq);
    assert.equal(body(await verifyBuild({ job_id: w.jobId, round: 2 }, w.deps)).final, true);
    assert.equal(body(await completeBuild({ job_id: w.jobId }, w.deps)).ok, true);
    assert.match(w.commits[0]!.files['contact.html']!, /data-vx-form="contact"/);
  });
});

describe('stopping and limits', () => {
  it('a stopped build refuses to start steps, keeps no page, still bills the tokens, and commits nothing', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await write(w, 'index.html', HOME);
    w.jobs.get(w.jobId)!.status = 'failed'; // the owner pressed Stop
    assert.equal(body(await startStep({ job_id: w.jobId, seq: 2 }, w.deps)).closed, true);
    const r = body(await write(w, 'shop.html', SHOP));
    assert.equal(r.closed, true);
    assert.equal(w.billed.length, 2, 'the in-flight call is still paid for');
    assert.equal(w.steps[2]!.output, null);
    assert.equal(body(await verifyBuild({ job_id: w.jobId, round: 1 }, w.deps)).closed, true);
    assert.equal(body(await completeBuild({ job_id: w.jobId }, w.deps)).closed, true);
    assert.equal(w.commits.length, 0);
  });
  it('stops the build when the owner runs out of credits part-way', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    w.state.credits = "You've used all your AI credits for this month.";
    const r = body(await startStep({ job_id: w.jobId, seq: 1 }, w.deps));
    assert.deepEqual({ ok: r.ok, stop: r.stop }, { ok: false, stop: true });
    assert.match(r.error as string, /AI credits/);
    assert.equal(w.steps[1]!.status, 'pending');
  });
  it('fail closes the job, skips what was waiting and marks what was running as interrupted', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await startStep({ job_id: w.jobId, seq: 1 }, w.deps);
    await write(w, 'shop.html', SHOP);
    assert.equal(body(await failBuildJob({ job_id: w.jobId, error: 'The AI service is down.' }, w.deps)).ok, true);
    assert.deepEqual(w.steps.map((s) => s.status), ['done', 'failed', 'done', 'skipped', 'skipped', 'skipped']);
    assert.equal(w.steps[1]!.detail, 'Interrupted');
    assert.deepEqual([w.jobs.get(w.jobId)!.status, (w.jobs.get(w.jobId) as { error?: string }).error], ['failed', 'The AI service is down.']);
    assert.deepEqual(body(await failBuildJob({ job_id: w.jobId, error: 'again' }, w.deps)), { ok: true, closed: true });
  });
  it('a commit that fails fails the job and saves no artifact', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w);
    w.state.commitFails = true;
    const c = body(await completeBuild({ job_id: w.jobId }, w.deps));
    assert.equal(c.ok, false);
    assert.match(c.error as string, /could not be saved/);
    assert.equal(w.saved.length, 0);
    assert.equal(w.jobs.get(w.jobId)!.status, 'failed');
  });
  it('completing twice is harmless', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w);
    await completeBuild({ job_id: w.jobId }, w.deps);
    assert.deepEqual(body(await completeBuild({ job_id: w.jobId }, w.deps)), { ok: true, duplicate: true });
    assert.equal(w.commits.length, 1);
  });
});

describe('request checking', () => {
  it('rejects unknown operations, bad step numbers and bad attempts', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    assert.equal((await runBuildOp({ op: 'explode', job_id: w.jobId }, w.deps)).status, 400);
    assert.equal((await startStep({ job_id: w.jobId, seq: 'x' }, w.deps)).status, 400);
    assert.equal((await startStep({ job_id: w.jobId, seq: 99 }, w.deps)).status, 404);
    assert.equal((await startStep({ job_id: w.jobId, seq: 0 }, w.deps)).status, 400, 'only page steps are written');
    assert.equal((await pageDone({ job_id: w.jobId, seq: 1, attempt: 0, files: {} }, w.deps)).status, 400);
    assert.equal((await pageDone({ job_id: w.jobId, seq: 1, attempt: 1.5, files: {} }, w.deps)).status, 400);
  });
  it('ignores a nonsense usage report instead of billing it', async () => {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await write(w, 'index.html', HOME, 1, 1, { in: -5, out: Number.NaN, cacheWrite: 'x', cacheRead: 0 } as unknown as Usage);
    assert.equal(w.billed.length, 0);
    assert.equal(w.steps[1]!.cost_cents, 0);
  });
  it('dispatches each operation by name', async () => {
    const w = world();
    assert.equal(body(await runBuildOp({ op: 'begin', job_id: w.jobId }, w.deps)).ok, true);
    assert.equal(body(await runBuildOp({ op: 'step_start', job_id: w.jobId, seq: 1 }, w.deps)).ok, true);
    assert.equal(body(await runBuildOp({ op: 'page_done', job_id: w.jobId, seq: 1, attempt: 1, files: { 'index.html': HOME } }, w.deps)).ok, true);
    assert.equal(body(await runBuildOp({ op: 'verify', job_id: w.jobId, round: 1 }, w.deps)).ok, true);
    assert.equal(body(await runBuildOp({ op: 'fail', job_id: w.jobId, error: 'x' }, w.deps)).ok, true);
  });
});

describe('recheck', () => {
  async function built(): Promise<World> {
    const w = world();
    await beginBuild({ job_id: w.jobId }, w.deps);
    await writeAll(w);
    await completeBuild({ job_id: w.jobId }, w.deps);
    return w;
  }
  it('verifies the site as it is saved now and saves a fresh report for the current manifest', async () => {
    const w = await built();
    const r = await recheckSite({ project_id: PROJECT }, OWNER, w.deps);
    assert.deepEqual(r.body, { ok: true, version: 2, site_ok: true, fails: 0, warns: 0 });
    assert.deepEqual(w.saved.map((s) => s.kind), ['manifest', 'launch_checks', 'launch_checks']);
    assert.equal((w.saved[2]!.data as { manifest_version: number }).manifest_version, 1);
  });
  it('notices what the owner broke by editing after the build', async () => {
    const w = await built();
    w.files['shop.html'] = w.files['shop.html']!.replace('Warm amber and cedar in a plain glass jar.', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.');
    const r = await recheckSite({ project_id: PROJECT }, OWNER, w.deps);
    assert.deepEqual([r.body.site_ok, r.body.fails], [false, 1]);
    assert.equal((w.saved.at(-1)!.data as { ok: boolean }).ok, false);
    delete w.files['contact.html'];
    assert.equal((await recheckSite({ project_id: PROJECT }, OWNER, w.deps)).body.site_ok, false, 'a missing page fails the check, it does not crash it');
  });
  it('needs access and a built site', async () => {
    const w = await built();
    w.state.access = false;
    assert.equal((await recheckSite({ project_id: PROJECT }, STRANGER, w.deps)).status, 404);
    assert.equal((await recheckSite({}, OWNER, w.deps)).status, 400);
    const fresh = world();
    assert.equal((await recheckSite({ project_id: PROJECT }, OWNER, fresh.deps)).status, 409);
  });
});

describe('the rows for a bulk insert', () => {
  it('all have the same keys (PostgREST refuses a batch whose rows differ), with defaults filled in', () => {
    const rows = stepInsertRows([
      { job_id: 'j', project_id: 'p', seq: 0, kind: 'prepare', file: null, label: 'Get everything ready', status: 'done', detail: 'ok' },
      { job_id: 'j', project_id: 'p', seq: 1, kind: 'page', file: 'index.html', label: 'Home' },
    ]);
    assert.deepEqual(Object.keys(rows[0]!).sort(), Object.keys(rows[1]!).sort());
    assert.deepEqual(rows[1], { job_id: 'j', project_id: 'p', seq: 1, kind: 'page', file: 'index.html', label: 'Home', status: 'pending', detail: null });
  });
});

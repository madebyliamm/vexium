// ai-chat stage endpoints — run:  node --test supabase/tests/ai_stages.test.ts   (Node ≥ 22.18 runs .ts directly)
// Exercises the real prompt builder + handler (supabase/functions/ai-chat/stages.ts, stage-handler.ts) against an in-memory StageDeps.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan } from '../functions/_shared/artifacts.ts';
import { applyPut, STAGES, STAGE_IO, type ArtifactKind, type LatestArtifacts, type Stage } from '../functions/_shared/stages.ts';
import { beginStage, cancelStageRun, cleanMessages, finishStageRun, isHttpError, type JobRow, type StageDeps, type StageRun } from '../functions/ai-chat/stage-handler.ts';
import { ARTIFACT_CLOSE, ARTIFACT_OPEN, buildStagePrompt, canonicalJson, extractArtifact, finishStage, inputBlockers } from '../functions/ai-chat/stages.ts';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = 'proj_1';

const plan = () => ({ ...emptyPlan('Bean There'), one_liner: 'Coffee subscriptions', audience: 'Home brewers', offer: 'A bag a month' });
const style = (locked = true) => ({
  schema: 1, locked, vibe: { theme: 'light', density: 'comfortable', tone: 'warm' },
  tokens: { '--accent': '#7c3aed' }, fonts: { display: 'Fraunces', body: 'Inter' },
});
const manifest = () => ({ schema: 1, built_at: '2026-10-14T10:00:00Z', pages: [{ file: 'index.html', title: 'Home' }], shared_files: ['styles.css'], backend: { collections: [], products: [], forms: [], auth: false } });

function latestWith(...entries: [ArtifactKind, Record<string, unknown>][]): LatestArtifacts {
  let l: LatestArtifacts = {};
  for (const [k, d] of entries) l = applyPut(l, k, d).latest;
  return l;
}
const FULL = () => latestWith(['plan', plan()], ['style_spec', style()], ['manifest', manifest()]);

interface World {
  deps: StageDeps;
  latest: LatestArtifacts;
  jobs: Map<string, JobRow & { error?: string; prompt?: string; artifact_kind?: string | null }>;
  saved: { kind: ArtifactKind; data: Record<string, unknown> }[];
  state: { credits: string | null; access: Set<string>; saveFails: boolean };
}

function makeWorld(latest: LatestArtifacts = {}): World {
  const w: World = { latest, jobs: new Map(), saved: [], state: { credits: null, access: new Set([`${PROJECT}:${OWNER}`]), saveFails: false }, deps: undefined as unknown as StageDeps };
  let n = 0;
  w.deps = {
    async getProjectAccess(projectId, userId) { return w.state.access.has(`${projectId}:${userId}`) ? { name: 'Bean There', stage: 'plan' } : null; },
    async getLatestArtifacts() { return w.latest; },
    async usageGate() { return w.state.credits; },
    async createJob(j) {
      for (const job of w.jobs.values()) if (job.project_id === j.project_id && job.stage && job.status === 'running') job.status = 'failed';
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      w.jobs.set(id, { id, project_id: j.project_id, user_id: j.user_id, stage: j.stage, status: 'running', prompt: j.prompt, artifact_kind: j.artifact_kind });
      return id;
    },
    async getJob(id) { return w.jobs.get(id) ?? null; },
    async finishJob(id, patch) {
      const j = w.jobs.get(id);
      if (j && j.status === 'running') Object.assign(j, patch);
    },
    async saveArtifact(_p, kind, data) {
      if (w.state.saveFails) throw new Error('rpc exploded');
      const r = applyPut(w.latest, kind, data);
      w.latest = r.latest;
      w.saved.push({ kind, data });
      return { version: r.version, staled: r.staled };
    },
  };
  return w;
}

const msgs = (text = 'I want to sell coffee subscriptions') => [{ role: 'user', content: text }];
const begin = (w: World, stage: unknown, extra: Record<string, unknown> = {}, user = OWNER) => beginStage({ stage, project_id: PROJECT, messages: msgs(), ...extra }, user, w.deps);
const mustRun = (r: StageRun | { status: number }): StageRun => {
  assert.ok(!isHttpError(r), `expected a run, got ${JSON.stringify(r)}`);
  return r as StageRun;
};
const reply = (kind: string, data: unknown, chat = 'Here you go.') => `${chat}\n${ARTIFACT_OPEN}\n${JSON.stringify(data)}\n${ARTIFACT_CLOSE}`;

// ── prompt assembly ─────────────────────────────────────────────────────────────────────────────────
describe('inputBlockers', () => {
  it('PLAN needs nothing; EXAMPLE needs a fresh plan; BUILD/TWEAKS need a LOCKED style', () => {
    assert.deepEqual(inputBlockers('plan', {}), []);
    assert.deepEqual(inputBlockers('example', {}), [{ kind: 'plan', reason: 'missing' }]);
    assert.deepEqual(inputBlockers('example', latestWith(['plan', plan()])), []);
    assert.deepEqual(inputBlockers('build', latestWith(['plan', plan()], ['style_spec', style(false)])), [{ kind: 'style_spec', reason: 'flag:locked' }]);
    assert.deepEqual(inputBlockers('tweaks', latestWith(['plan', plan()])), [{ kind: 'style_spec', reason: 'missing' }]);
    assert.deepEqual(inputBlockers('build', latestWith(['plan', plan()], ['style_spec', style()])), []);
  });

  it('a stale input blocks the run (an earlier stage changed after it was made)', () => {
    const l = applyPut(latestWith(['plan', plan()], ['style_spec', style()]), 'plan', plan()).latest;
    assert.deepEqual(inputBlockers('build', l), [{ kind: 'style_spec', reason: 'stale' }]);
  });

  it('the artifact a stage works on may be missing or stale — only its INPUTS are checked', () => {
    assert.deepEqual(inputBlockers('launch', latestWith(['manifest', manifest()])), []);
    const l = applyPut(latestWith(['manifest', manifest()], ['launch_checks', { schema: 1 }]), 'manifest', manifest()).latest;
    assert.deepEqual(inputBlockers('launch', l), []); // launch_checks is stale, but it is what launch works on
  });
});

describe('buildStagePrompt — cache stability', () => {
  it('the cached system block is byte-identical across calls', () => {
    const a = buildStagePrompt('build', FULL(), { projectName: 'X' });
    const b = buildStagePrompt('build', FULL(), { projectName: 'X' });
    assert.equal(a.system, b.system);
    assert.equal(a.suffix, b.suffix);
  });

  it('it does not depend on the key order of the stored JSON', () => {
    const p1 = latestWith(['plan', { schema: 1, name: 'A', kind: 'site' }]);
    const p2 = latestWith(['plan', { kind: 'site', name: 'A', schema: 1 }]);
    assert.equal(buildStagePrompt('example', p1).system, buildStagePrompt('example', p2).system);
  });

  it('editing the artifact a stage works on changes only the suffix', () => {
    const before = latestWith(['plan', plan()], ['style_spec', style(false)]);
    const after = applyPut(before, 'style_spec', style(true)).latest;
    const a = buildStagePrompt('example', before);
    const b = buildStagePrompt('example', after);
    assert.equal(a.system, b.system);
    assert.notEqual(a.suffix, b.suffix);
  });

  it('PLAN: the plan being edited is NOT in the cached block (it changes every turn)', () => {
    const p = buildStagePrompt('plan', latestWith(['plan', plan()]));
    assert.ok(!p.system.includes('Bean There'));
    assert.ok(p.suffix.includes('Bean There') && p.suffix.includes('CURRENT plan (version 1)'));
  });

  it('only the stage\'s inputs reach the cached block — not the other artifacts', () => {
    const l = FULL();
    const ex = buildStagePrompt('example', l);
    assert.ok(ex.system.includes('### plan (version 1)'));
    assert.ok(!ex.system.includes('### style_spec') && !ex.system.includes('### manifest'));
    const bd = buildStagePrompt('build', l);
    assert.ok(bd.system.includes('### plan') && bd.system.includes('### style_spec') && !bd.system.includes('### manifest'));
    assert.ok(bd.suffix.includes('CURRENT manifest (version 1)'));
  });

  it('a new version of an INPUT changes the system block (that is correct: the cache must miss)', () => {
    const a = buildStagePrompt('example', latestWith(['plan', plan()]));
    const b = buildStagePrompt('example', latestWith(['plan', { ...plan(), name: 'Other' }]));
    assert.notEqual(a.system, b.system);
  });

  it('the project name and "out of date" note live in the suffix only', () => {
    const l = applyPut(latestWith(['plan', plan()], ['style_spec', style(false)]), 'plan', plan()).latest; // style_spec now stale
    const p = buildStagePrompt('example', l, { projectName: 'Zed Project' });
    assert.ok(!p.system.includes('Zed Project'));
    assert.ok(p.suffix.includes('Zed Project') && p.suffix.includes('OUT OF DATE'));
  });

  it('every stage builds; stages that save nothing say so; the others describe the markers', () => {
    for (const s of STAGES) {
      const l = FULL();
      const p = buildStagePrompt(s, l);
      assert.ok(p.system.length > 200 && p.maxTokens > 0 && (p.model === 'build' || p.model === 'fast'));
      if (STAGE_IO[s].produces) assert.ok(p.system.includes(ARTIFACT_OPEN) && p.system.includes(`updated ${STAGE_IO[s].produces}`), s);
      else assert.ok(p.system.includes('does not save anything'), s);
    }
  });

  it('the exact JSON shape of what the stage saves is in the cached block, and it is the shape the validator accepts', () => {
    const ex = buildStagePrompt('plan', {}).system;
    for (const key of ['"one_liner"', '"pricing"', '"launch_checklist"', '"backend"']) assert.ok(ex.includes(key), key);
    assert.ok(buildStagePrompt('example', latestWith(['plan', plan()])).system.includes('"tokens"'));
    assert.ok(buildStagePrompt('build', FULL()).system.includes('"shared_files"'));
  });

  it('the no-fake-content rule is in every stage', () => {
    for (const s of STAGES) assert.match(buildStagePrompt(s, FULL()).system, /Never invent facts/);
  });

  it('canonicalJson sorts keys at every depth and keeps arrays in order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: 2 } }), '{"a":{"c":2,"d":[3,1]},"b":1}');
  });
});

// ── reply parsing ───────────────────────────────────────────────────────────────────────────────────
describe('extractArtifact / finishStage', () => {
  it('a reply with no block is plain chat', () => {
    assert.deepEqual(extractArtifact('  Just chatting. '), { chat: 'Just chatting.' });
    assert.deepEqual(finishStage('plan', 'Tell me more about your customers.'), { chat: 'Tell me more about your customers.', artifact: null });
  });

  it('pulls the block out of the chat and parses it', () => {
    const x = extractArtifact(reply('plan', { a: 1 }, 'Done — I added a pricing page.'));
    assert.equal(x.chat, 'Done — I added a pricing page.');
    assert.deepEqual(x.json, { a: 1 });
    assert.equal(x.error, undefined);
  });

  it('tolerates a code fence inside the markers and text after the block', () => {
    const x = extractArtifact(`Hi\n${ARTIFACT_OPEN}\n\`\`\`json\n{"a":2}\n\`\`\`\n${ARTIFACT_CLOSE}\nBye`);
    assert.deepEqual(x.json, { a: 2 });
    assert.equal(x.chat, 'Hi\n\nBye');
  });

  it('the LAST block wins', () => {
    assert.deepEqual(extractArtifact(`${ARTIFACT_OPEN}{"v":1}${ARTIFACT_CLOSE} then ${ARTIFACT_OPEN}{"v":2}${ARTIFACT_CLOSE}`).json, { v: 2 });
  });

  it('an unterminated or unreadable block is an error and saves nothing', () => {
    const cut = finishStage('plan', `Sure.\n${ARTIFACT_OPEN}\n{"schema":1,"name":"Bean`);
    assert.equal(cut.artifact, null);
    assert.match(cut.error!, /stopped in the middle/);
    assert.equal(cut.chat, 'Sure.');
    const junk = finishStage('plan', `${ARTIFACT_OPEN}not json${ARTIFACT_CLOSE}`);
    assert.equal(junk.artifact, null);
    assert.match(junk.error!, /could not be read/);
  });

  it('a valid plan becomes an artifact; an invalid one is refused with a reason', () => {
    const ok = finishStage('plan', reply('plan', plan()));
    assert.equal(ok.error, undefined);
    assert.equal(ok.artifact?.kind, 'plan');
    assert.equal((ok.artifact?.data as { name: string }).name, 'Bean There');
    const bad = finishStage('plan', reply('plan', { ...plan(), kind: 'blog', pages: 'index' }));
    assert.equal(bad.artifact, null);
    assert.match(bad.error!, /plan was incomplete \(kind: must be/);
  });

  it('a stage that saves nothing ignores (and hides) a block the model adds anyway', () => {
    const r = finishStage('launch', reply('launch_checks', { schema: 1, ok: true }, 'All good.'));
    assert.equal(r.artifact, null);
    assert.equal(r.error, undefined);
    assert.equal(r.chat, 'All good.');
  });

  it('a plan with "interval": null (a model habit) is accepted', () => {
    const r = finishStage('plan', reply('plan', { ...plan(), pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2800, interval: null }] } }));
    assert.equal(r.error, undefined);
    assert.equal(r.artifact?.kind, 'plan');
  });

  it('a model can never LOCK a style — only the owner does (the saved style is always unlocked)', () => {
    const r = finishStage('example', reply('style_spec', style(true)));
    assert.equal(r.error, undefined);
    assert.equal((r.artifact?.data as { locked: boolean }).locked, false);
  });

  it('the style a model saves must be a real style (tokens end up inside CSS)', () => {
    const r = finishStage('example', reply('style_spec', { ...style(false), tokens: { '--accent': 'red;}</style>' } }));
    assert.equal(r.artifact, null);
    assert.match(r.error!, /style spec was incomplete/);
  });
});

// ── the handler ─────────────────────────────────────────────────────────────────────────────────────
describe('cleanMessages', () => {
  it('accepts a text conversation that starts and ends with the user', () => {
    assert.deepEqual(cleanMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ]);
  });
  it('rejects everything else with a reason', () => {
    for (const bad of [undefined, null, 'hi', [], [{ role: 'system', content: 'x' }], [{ role: 'user', content: 5 }], [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      [{ role: 'assistant', content: 'x' }], [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], [null], [{ role: 'user', content: 'x'.repeat(20_001) }],
      Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' }))]) {
      assert.equal(typeof cleanMessages(bad), 'string', JSON.stringify(bad)?.slice(0, 60));
    }
  });
});

describe('beginStage', () => {
  it('rejects a bad stage / project / conversation with 400 and creates no job', async () => {
    const w = makeWorld();
    for (const body of [{ stage: 'bogus' }, { stage: 5 }, { stage: 'plan', project_id: '' }, { stage: 'plan', project_id: 7 }, { stage: 'plan', project_id: PROJECT, messages: [] }]) {
      const r = await beginStage({ messages: msgs(), ...body }, OWNER, w.deps);
      assert.ok(isHttpError(r) && r.status === 400, JSON.stringify(body));
    }
    assert.equal(w.jobs.size, 0);
  });

  it('a stranger gets 404 — the same as an unknown project — and creates nothing', async () => {
    const w = makeWorld();
    const r = await begin(w, 'plan', {}, STRANGER);
    assert.ok(isHttpError(r) && r.status === 404 && r.body.code === 'not_found');
    const r2 = await beginStage({ stage: 'plan', project_id: 'nope', messages: msgs() }, OWNER, w.deps);
    assert.ok(isHttpError(r2) && r2.status === 404);
    assert.equal(w.jobs.size, 0);
  });

  it('missing inputs → 409 with a plain-English reason and the machine-readable list', async () => {
    const w = makeWorld();
    const r = await begin(w, 'example');
    assert.ok(isHttpError(r));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'stage_inputs');
    assert.match(r.body.error, /Needs your plan first/);
    assert.deepEqual(r.body.blocked_by, [{ kind: 'plan', reason: 'missing' }]);
    assert.equal(w.jobs.size, 0);
  });

  it('an unlocked style blocks the full build', async () => {
    const w = makeWorld(latestWith(['plan', plan()], ['style_spec', style(false)]));
    const r = await begin(w, 'build');
    assert.ok(isHttpError(r) && r.status === 409 && /Lock your style first/.test(r.body.error));
  });

  it('out of credits → 402 and no job (no AI is run)', async () => {
    const w = makeWorld();
    w.state.credits = 'Your free trial has ended. Upgrade to keep building.';
    const r = await begin(w, 'plan');
    assert.ok(isHttpError(r) && r.status === 402 && r.body.code === 'usage_limit' && /trial has ended/.test(r.body.error));
    assert.equal(w.jobs.size, 0);
  });

  it('a good request returns the prompt and records a running stage job', async () => {
    const w = makeWorld();
    const run = mustRun(await begin(w, 'plan', { messages: msgs('x'.repeat(900)) }));
    assert.equal(run.stage, 'plan');
    assert.equal(run.prompt.model, 'fast');
    const job = w.jobs.get(run.jobId)!;
    assert.deepEqual([job.project_id, job.user_id, job.stage, job.status, job.artifact_kind], [PROJECT, OWNER, 'plan', 'running', 'plan']);
    assert.equal(job.prompt!.length, 500, 'the stored prompt is truncated');
    assert.equal(run.messages.length, 1);
  });

  it('a new run supersedes the previous running one', async () => {
    const w = makeWorld();
    const a = mustRun(await begin(w, 'plan'));
    const b = mustRun(await begin(w, 'plan'));
    assert.equal(w.jobs.get(a.jobId)!.status, 'failed');
    assert.equal(w.jobs.get(b.jobId)!.status, 'running');
  });

  it('the system block is identical on every turn of a plan session, even after the plan itself changed', async () => {
    const w = makeWorld();
    const first = mustRun(await begin(w, 'plan'));
    const saved = await finishStageRun({ job_id: first.jobId, ok: true, message: reply('plan', plan()) }, OWNER, w.deps, true);
    assert.ok(!isHttpError(saved) && saved.body.ok);
    const second = mustRun(await begin(w, 'plan', { messages: [...msgs(), { role: 'assistant', content: 'ok' }, ...msgs('and a pricing page')] }));
    assert.equal(first.prompt.system, second.prompt.system);
    assert.notEqual(first.prompt.suffix, second.prompt.suffix);
  });
});

describe('finishStageRun', () => {
  const start = async (w: World, stage: Stage = 'plan') => mustRun(await begin(w, stage)).jobId;
  const done = (w: World, body: Record<string, unknown>, user = OWNER) => finishStageRun(body, user, w.deps, true);

  it('saves the plan, closes the job, reports the version', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true, message: reply('plan', plan()) });
    assert.ok(!isHttpError(r));
    assert.deepEqual(r.body, { ok: true, artifact: { kind: 'plan', version: 1, staled: [] } });
    assert.equal(w.jobs.get(job_id)!.status, 'complete');
    assert.equal(w.saved.length, 1);
  });

  it('saving a new plan reports the downstream artifacts it made stale', async () => {
    const w = makeWorld(latestWith(['plan', plan()], ['style_spec', style()], ['manifest', manifest()]));
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true, message: reply('plan', { ...plan(), name: 'Renamed' }) });
    assert.ok(!isHttpError(r));
    assert.deepEqual(r.body.artifact, { kind: 'plan', version: 2, staled: ['manifest', 'style_spec'] });
  });

  it('a chat-only turn completes the job and saves nothing', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true, message: 'What is your price range?' });
    assert.ok(!isHttpError(r));
    assert.deepEqual(r.body, { ok: true, artifact: null });
    assert.equal(w.jobs.get(job_id)!.status, 'complete');
    assert.equal(w.saved.length, 0);
  });

  it('an unusable reply fails the job with the reason and saves nothing', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true, message: reply('plan', { schema: 1, name: '' }) });
    assert.ok(!isHttpError(r));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error!, /incomplete/);
    assert.equal(w.jobs.get(job_id)!.status, 'failed');
    assert.match(w.jobs.get(job_id)!.error!, /incomplete/);
    assert.equal(w.saved.length, 0);
  });

  it('a run the Worker reports as failed (stopped, error) fails the job', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: false, error: 'Stopped' });
    assert.ok(!isHttpError(r) && !r.body.ok && r.body.error === 'Stopped');
    assert.equal(w.jobs.get(job_id)!.status, 'failed');
    assert.equal((await done(w, { job_id, ok: false })).status, 409, 'closed jobs stay closed');
  });

  it('a missing reply fails the job', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true });
    assert.ok(!isHttpError(r) && !r.body.ok);
    assert.equal(w.jobs.get(job_id)!.status, 'failed');
  });

  it('only the build Worker may report a result — the user\'s own token is not enough (no forging an artifact via a self-prepared run)', async () => {
    const w = makeWorld(latestWith(['plan', plan()], ['style_spec', style()]));
    const job_id = mustRun(await beginStage({ stage: 'build', project_id: PROJECT, messages: msgs() }, OWNER, w.deps)).jobId; // the user can prepare a run themselves…
    const forged = await finishStageRun({ job_id, ok: true, message: reply('manifest', manifest()) }, OWNER, w.deps, false); // …but not report one
    assert.ok(isHttpError(forged) && forged.status === 403 && forged.body.code === 'forbidden');
    assert.equal(w.saved.length, 0);
    assert.equal(w.jobs.get(job_id)!.status, 'running', 'the refused report does not touch the job');
    const real = await finishStageRun({ job_id, ok: true, message: reply('manifest', manifest()) }, OWNER, w.deps, true);
    assert.ok(!isHttpError(real) && real.body.ok);
  });

  it('is single-use: a second report for the same job is refused and saves nothing more', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    await done(w, { job_id, ok: true, message: reply('plan', plan()) });
    const again = await done(w, { job_id, ok: true, message: reply('plan', { ...plan(), name: 'Evil' }) });
    assert.ok(isHttpError(again) && again.status === 409 && again.body.code === 'job_closed');
    assert.equal(w.saved.length, 1);
  });

  it('refuses jobs that are not yours, not stage jobs, malformed, or unknown — all look like "not found" / 400', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const other = await done(w, { job_id, ok: true, message: reply('plan', plan()) }, STRANGER);
    assert.ok(isHttpError(other) && other.status === 404);
    // the old editor's job rows have stage = null: they can never be used to write an artifact
    w.jobs.set('00000000-0000-4000-8000-0000000000ff', { id: '00000000-0000-4000-8000-0000000000ff', project_id: PROJECT, user_id: OWNER, stage: null, status: 'running' });
    const legacy = await done(w, { job_id: '00000000-0000-4000-8000-0000000000ff', ok: true, message: reply('plan', plan()) });
    assert.ok(isHttpError(legacy) && legacy.status === 404);
    assert.ok(isHttpError(await done(w, { job_id: 'not-a-uuid', ok: true, message: 'x' })) && true);
    assert.equal((await done(w, { job_id: 'not-a-uuid', ok: true, message: 'x' })).status, 400);
    assert.equal((await done(w, { job_id: '00000000-0000-4000-8000-0000000000aa', ok: true, message: 'x' })).status, 404);
    assert.equal(w.saved.length, 0);
    assert.equal(w.jobs.get(job_id)!.status, 'running', 'a stranger cannot close your job');
  });

  it('access removed mid-run: nothing is saved and the job fails', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    w.state.access.clear();
    const r = await done(w, { job_id, ok: true, message: reply('plan', plan()) });
    assert.ok(isHttpError(r) && r.status === 404);
    assert.equal(w.jobs.get(job_id)!.status, 'failed');
    assert.equal(w.saved.length, 0);
  });

  it('a save that throws fails the job with a friendly message (and the detail kept for debugging)', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    w.state.saveFails = true;
    const r = await done(w, { job_id, ok: true, message: reply('plan', plan()) });
    assert.ok(!isHttpError(r) && !r.body.ok);
    assert.match(r.body.error!, /could not be saved/);
    assert.match(w.jobs.get(job_id)!.error!, /rpc exploded/);
  });

  it('oversized replies are refused', async () => {
    const w = makeWorld();
    const job_id = await start(w);
    const r = await done(w, { job_id, ok: true, message: 'x'.repeat(400_001) });
    assert.ok(isHttpError(r) && r.status === 413);
  });

  it('a stage that produces nothing never saves, even if the model sends a block', async () => {
    const w = makeWorld(latestWith(['manifest', manifest()]));
    const job_id = mustRun(await begin(w, 'launch')).jobId;
    const r = await done(w, { job_id, ok: true, message: reply('launch_checks', { schema: 1, ok: true, checks: [] }) });
    assert.ok(!isHttpError(r));
    assert.deepEqual(r.body, { ok: true, artifact: null });
    assert.equal(w.saved.length, 0);
  });
});

describe('cancelStageRun (the Stop button)', () => {
  const JOB = '00000000-0000-4000-8000-0000000000aa';

  it('closes a running job as "Stopped" so the Worker aborts on its next heartbeat', async () => {
    const w = makeWorld();
    const jobId = mustRun(await begin(w, 'plan')).jobId;
    const r = await cancelStageRun({ job_id: jobId }, OWNER, w.deps);
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.equal(w.jobs.get(jobId)!.status, 'failed');
    assert.equal(w.jobs.get(jobId)!.error, 'Stopped');
  });

  it('the Worker\'s late report after a Stop saves nothing (the job is closed)', async () => {
    const w = makeWorld();
    const jobId = mustRun(await begin(w, 'plan')).jobId;
    await cancelStageRun({ job_id: jobId }, OWNER, w.deps);
    const late = await finishStageRun({ job_id: jobId, ok: true, message: reply('plan', plan()) }, OWNER, w.deps, true);
    assert.ok(isHttpError(late) && late.status === 409);
    assert.equal(w.saved.length, 0);
  });

  it('is idempotent on a finished job, and refuses strangers / legacy jobs / junk', async () => {
    const w = makeWorld();
    const jobId = mustRun(await begin(w, 'plan')).jobId;
    await finishStageRun({ job_id: jobId, ok: true, message: 'chat only' }, OWNER, w.deps, true);
    assert.deepEqual(await cancelStageRun({ job_id: jobId }, OWNER, w.deps), { status: 200, body: { ok: true } });
    assert.equal(w.jobs.get(jobId)!.status, 'complete', 'a finished job is not rewritten');
    const live = mustRun(await begin(w, 'plan')).jobId;
    const stranger = await cancelStageRun({ job_id: live }, STRANGER, w.deps);
    assert.ok(isHttpError(stranger) && stranger.status === 404);
    assert.equal(w.jobs.get(live)!.status, 'running', 'a stranger cannot stop your run');
    w.jobs.set(JOB, { id: JOB, project_id: PROJECT, user_id: OWNER, stage: null, status: 'running' });
    const legacy = await cancelStageRun({ job_id: JOB }, OWNER, w.deps);
    assert.ok(isHttpError(legacy) && legacy.status === 404);
    const junk = await cancelStageRun({ job_id: 'x' }, OWNER, w.deps);
    assert.ok(isHttpError(junk) && junk.status === 400);
  });
});

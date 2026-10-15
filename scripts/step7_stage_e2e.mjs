#!/usr/bin/env node
// REVAMP Step 7 live evidence: the stage engine + stage endpoints against the DEPLOYED build Worker, ai-chat and database.
//
//   node scripts/step7_stage_e2e.mjs            (needs the `supabase` CLI logged in; network; a few cents of real AI usage)
//
// Creates two throwaway users (owner + stranger) and one project, and deletes them in `finally`. Covers: request guards (no AI),
// a real PLAN run saved server-side as an artifact, stale-marking, moving the stage with the real RPCs, a run that survives the
// browser disconnecting (resume-after-refresh), the Stop button, the credit gate, and that clients cannot forge stage jobs /
// platform-only artifacts / the stage column.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const EDGE = `${SB}/functions/v1/ai-chat`;
const WORKER = 'https://vexium-ai-build.startafter.workers.dev';
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-step7-e2e)' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 260)}]` : '')); };
const info = (m) => console.log('INFO ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const svcKey = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { encoding: 'utf8' }))
  .find((k) => k.name === 'service_role' || k.id === 'service_role').api_key;
const svc = { apikey: svcKey, Authorization: 'Bearer ' + svcKey, 'Content-Type': 'application/json' };

async function jfetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const user = (token) => ({ apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
const rest = (path, init) => jfetch(`${SB}/rest/v1/${path}`, init);
const rpc = (name, token, body) => jfetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: user(token), body: JSON.stringify(body) });

/** POST a stage run to the Worker and read the SSE stream. `until(event)` may return true to disconnect early. */
async function runStage(token, body, { until, timeoutMs = 120000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const events = [];
  let res;
  try {
    res = await fetch(WORKER, { method: 'POST', headers: { ...UA, ...user(token) }, body: JSON.stringify({ stream: true, ...body }), signal: ctl.signal });
    if (!res.ok) return { status: res.status, events, error: await res.json().catch(() => null) };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev) continue;
        let parsed = null; try { parsed = JSON.parse(data); } catch { /* ignore */ }
        const e = { event: ev, data: parsed };
        events.push(e);
        if (until?.(e)) { ctl.abort(); break outer; }
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e;
  } finally { clearTimeout(timer); }
  return { status: res?.status ?? 0, events };
}
const stageDone = (r) => r.events.find((e) => e.event === 'stage_done')?.data;

const rand = Math.random().toString(36).slice(2, 8);
const mk = async (tag) => {
  const username = `vxstage${tag}${rand}`;
  const email = `${username}@vexium.ai`;
  const password = 'Stage-e2e-' + rand + '!7';
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  const id = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  return { id, token: r.json.access_token };
};

const PID = 'e2e-stage-' + rand;
let owner = null, stranger = null;
try {
  owner = await mk('o');
  stranger = await mk('s');
  let r = await rest('projects', { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, user_id: owner.id, name: 'Stage E2E ' + rand, files: {}, main_file: 'index.html' }) });
  if (r.status >= 300) throw new Error('create project failed: ' + r.text);
  const latest = async () => Object.fromEntries(((await rest(`project_artifacts_latest?project_id=eq.${PID}&select=kind,version,stale,data`, { headers: user(owner.token) })).json ?? []).map((a) => [a.kind, a]));
  const lastJob = async () => (await rest(`build_jobs?project_id=eq.${PID}&stage=not.is.null&order=created_at.desc&limit=1&select=id,stage,status,error,heartbeat_at,finished_at,created_at`, { headers: svc })).json?.[0];
  const msg = (text) => [{ role: 'user', content: text }];
  const IDEA = 'I want to sell hand-poured soy candles online to people in Canada. A candle is $28. Please write the plan now and save it — pages: home, shop, about.';

  // ── A. guards (no AI is run, no money spent) ────────────────────────────────────────────────────────
  r = await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage: 'plan', project_id: PID, messages: msg('hi') }) });
  check('ai-chat refuses a stage run that is not routed through the build Worker (400 use_worker)', r.status === 400 && r.json?.code === 'use_worker', r.text);
  r = await jfetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'plan', project_id: PID, messages: msg('hi') }) });
  check('stage run without a session → 401', r.status === 401, r.text);
  r = await runStage(owner.token, { stage: 'bogus', project_id: PID, messages: msg('hi') });
  check('unknown stage → 400', r.status === 400 && r.error?.code === 'bad_stage', JSON.stringify(r.error));
  r = await runStage(owner.token, { stage: 'plan', project_id: PID, messages: [{ role: 'assistant', content: 'x' }] });
  check('conversation must start with the user → 400', r.status === 400 && r.error?.code === 'bad_messages', JSON.stringify(r.error));
  r = await runStage(stranger.token, { stage: 'plan', project_id: PID, messages: msg('hi') });
  check("a stranger can't run a stage on someone else's project → 404", r.status === 404 && r.error?.code === 'not_found', JSON.stringify(r.error));
  r = await runStage(owner.token, { stage: 'plan', project_id: 'no-such-project', messages: msg('hi') });
  check('unknown project looks identical (404)', r.status === 404, JSON.stringify(r.error));
  r = await runStage(owner.token, { stage: 'example', project_id: PID, messages: msg('make it warm') });
  check('EXAMPLE without a plan → 409 with a plain-English reason', r.status === 409 && r.error?.code === 'stage_inputs' && /Needs your plan first/.test(r.error?.error) && r.error?.blocked_by?.[0]?.kind === 'plan', JSON.stringify(r.error));
  const jobCount = async () => ((await rest(`build_jobs?project_id=eq.${PID}&stage=not.is.null&select=id`, { headers: svc })).json ?? []).length;
  check('…and no job was created by the refused runs', (await jobCount()) === 0);

  const WORKER_SECRET = process.env.E2E_STAGE_WORKER_SECRET || ''; // the secret shared by the Worker and ai-chat (never in the repo)
  const workerHdr = { ...user(owner.token), 'x-vx-worker-key': WORKER_SECRET }; // what the build Worker sends
  r = await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage_done: { job_id: '00000000-0000-4000-8000-000000000abc', ok: true, message: 'x' } }) });
  check('stage_done from a browser (no Worker key) → 403', r.status === 403 && r.json?.code === 'forbidden', r.text);
  r = await jfetch(EDGE, { method: 'POST', headers: { ...user(owner.token), 'x-vx-worker-key': 'not-the-key' }, body: JSON.stringify({ stage_done: { job_id: '00000000-0000-4000-8000-000000000abc', ok: true, message: 'x' } }) });
  check('…a wrong Worker key → 403 too', r.status === 403, r.text);
  if (WORKER_SECRET) {
  r = await jfetch(EDGE, { method: 'POST', headers: workerHdr, body: JSON.stringify({ stage_done: { job_id: '00000000-0000-4000-8000-000000000abc', ok: true, message: 'x' } }) });
  check('stage_done for an unknown job → 404 (with the Worker key)', r.status === 404, r.text);
  r = await rest('build_jobs', { method: 'POST', headers: { ...svc, Prefer: 'return=representation' }, body: JSON.stringify({ project_id: PID, user_id: owner.id, status: 'running', prompt: 'legacy' }) });
  const legacyJob = r.json?.[0]?.id;
  r = await jfetch(EDGE, { method: 'POST', headers: workerHdr, body: JSON.stringify({ stage_done: { job_id: legacyJob, ok: true, message: '[[ARTIFACT]]{"schema":1}[[/ARTIFACT]]' } }) });
  check("a job without a stage (the old editor's) can never be used to save an artifact → 404", r.status === 404, r.text);
  await rest(`build_jobs?id=eq.${legacyJob}`, { method: 'DELETE', headers: svc });
  } else info('E2E_STAGE_WORKER_SECRET not set — skipped the checks that need the Worker key (they are unit-tested in ai_stages.test.ts)');
  // the side door: prepare a run yourself (prepare:true is allowed for any signed-in user), then try to "report" a forged result
  r = await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage: 'plan', project_id: PID, prepare: true, messages: msg('hi') }) });
  const selfJob = r.json?.job?.id;
  check('a user can prepare a run themselves (gets a job id)…', r.status === 200 && r.json?.kind === 'run' && !!selfJob, r.text.slice(0, 120));
  r = await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage_done: { job_id: selfJob, ok: true, message: '[[ARTIFACT]]' + JSON.stringify({ schema: 1, name: 'FORGED', kind: 'site', one_liner: '', audience: '', offer: '', pricing: { model: 'none', items: [] }, pages: [{ file: 'index.html', title: 'x', purpose: '' }], backend: { collections: [], products: [], forms: [], auth: false }, launch_checklist: [], scenario: null }) + '[[/ARTIFACT]]' } }) });
  check('…but cannot report a forged result for it (403) — nothing is saved', r.status === 403 && Object.keys(await latest()).length === 0, r.text);
  await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage_cancel: { job_id: selfJob } }) });

  r = await rest('build_jobs', { method: 'POST', headers: { ...user(owner.token), Prefer: 'return=minimal' }, body: JSON.stringify({ project_id: PID, user_id: owner.id, status: 'running', prompt: 'x', stage: 'launch' }) });
  check('a client can NOT mint a stage job (column not writable)', r.status === 401 || r.status === 403, `${r.status} ${r.text}`);
  r = await rest(`projects?id=eq.${PID}`, { method: 'PATCH', headers: { ...user(owner.token), Prefer: 'return=minimal' }, body: JSON.stringify({ stage: 'launch' }) });
  check('a client can NOT set projects.stage directly', r.status === 403 || r.status === 401, `${r.status} ${r.text}`);
  r = await rpc('put_project_artifact', owner.token, { p_project: PID, p_kind: 'launch_checks', p_data: { schema: 1, ok: true, checks: [] } });
  check('a client can NOT forge a launch check (platform-only kind) → 403', r.status === 403, `${r.status} ${r.text}`);
  r = await rpc('put_project_artifact', stranger.token, { p_project: PID, p_kind: 'plan', p_data: { schema: 1 } });
  check("a stranger can NOT write to someone else's project → 403", r.status === 403, `${r.status} ${r.text}`);
  r = await rest(`project_artifacts?project_id=eq.${PID}&select=id`, { headers: user(stranger.token) });
  check('a stranger reads nothing from project_artifacts (RLS)', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r.text);
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'example' });
  check('moving to EXAMPLE with no plan is refused (ok:false, plan missing)', r.status === 200 && r.json?.ok === false && r.json?.blocked_by?.[0]?.kind === 'plan', r.text);

  // ── B. credit gate ─────────────────────────────────────────────────────────────────────────────────
  const bill = (await rest(`account_billing?user_id=eq.${owner.id}&select=credits_used_cents`, { headers: svc })).json?.[0];
  if (bill) {
    await rest(`account_billing?user_id=eq.${owner.id}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ credits_used_cents: 99999999 }) });
    r = await runStage(owner.token, { stage: 'plan', project_id: PID, messages: msg(IDEA) });
    check('out of credits → 402 usage_limit and nothing runs', r.status === 402 && r.error?.code === 'usage_limit', JSON.stringify(r.error));
    await rest(`account_billing?user_id=eq.${owner.id}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ credits_used_cents: bill.credits_used_cents }) });
    check('…and no job was created for it', (await jobCount()) === 1, 'only the self-prepared one from the forgery check');
  } else info('no account_billing row for the throwaway user — credit-gate check skipped');

  // ── C. a REAL plan run, saved server-side ──────────────────────────────────────────────────────────
  let plan1 = null;
  for (let attempt = 1; attempt <= 3 && !plan1; attempt++) {
    const run = await runStage(owner.token, { stage: 'plan', project_id: PID, messages: msg(attempt === 1 ? IDEA : IDEA + ' (Remember: end your reply with the saved plan JSON between the markers.)') });
    const types = run.events.map((e) => e.event);
    info(`plan run #${attempt}: status ${run.status}, events: ${[...new Set(types)].join(',')}`);
    for (const e of run.events.filter((x) => x.event === 'error')) info('  error event: ' + JSON.stringify(e.data).slice(0, 300));
    const done = stageDone(run);
    if (attempt === 1) {
      check('plan run streams: stage_job first, then the reply, `done`, and `stage_done` LAST', run.status === 200 && types[0] === 'stage_job', types.slice(0, 4).join(','));
      check('stage_job carries the job id + stage', run.events.find((e) => e.event === 'stage_job')?.data?.stage === 'plan' && /^[0-9a-f-]{36}$/.test(run.events.find((e) => e.event === 'stage_job')?.data?.job_id ?? ''));
      check('stage_done is the last event', types.at(-1) === 'stage_done', types.at(-3) + ',' + types.at(-2) + ',' + types.at(-1));
    }
    if (done?.ok && done.artifact?.kind === 'plan') plan1 = done;
    else info(`  not saved: ${JSON.stringify(done)}`);
  }
  check('the server saved the AI\'s plan as artifact plan v1', plan1?.artifact?.version === 1, JSON.stringify(plan1));
  let L = await latest();
  check('plan is in project_artifacts_latest, fresh, schema 1', L.plan?.version === 1 && L.plan.stale === false && L.plan.data?.schema === 1, JSON.stringify(L.plan?.data ?? null).slice(0, 200));
  check('the saved plan is real content: a name, ≥1 page, a pricing model, a launch checklist list', typeof L.plan?.data?.name === 'string' && L.plan.data.name.trim().length > 0 && L.plan.data.pages?.length >= 1 && typeof L.plan.data.pricing?.model === 'string' && Array.isArray(L.plan.data.launch_checklist), JSON.stringify(L.plan?.data ?? null).slice(0, 300));
  info('plan: ' + JSON.stringify(L.plan?.data ?? null).slice(0, 400));
  let job = await lastJob();
  check('the job row: complete, heartbeat stamped, finished_at set, stage plan', job?.status === 'complete' && job.stage === 'plan' && !!job.heartbeat_at && !!job.finished_at && !job.error, JSON.stringify(job));
  r = await jfetch(EDGE, { method: 'POST', headers: workerHdr, body: JSON.stringify({ stage_done: { job_id: job.id, ok: true, message: '[[ARTIFACT]]{"schema":1}[[/ARTIFACT]]' } }) });
  if (WORKER_SECRET) check('a finished job cannot be replayed to write another artifact (409)', r.status === 409, r.text);

  // ── D. move the stage with the real RPC; stage inputs now open EXAMPLE ──────────────────────────────
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'example' });
  check('with a plan, EXAMPLE opens', r.json?.ok === true && r.json.stage === 'example', r.text);
  check('projects.stage follows', (await rest(`projects?id=eq.${PID}&select=stage`, { headers: user(owner.token) })).json?.[0]?.stage === 'example');
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'build' });
  check('BUILD is blocked: the style does not exist yet', r.json?.ok === false && r.json.blocked_by?.[0]?.kind === 'style_spec' && r.json.blocked_by[0].reason === 'missing', r.text);

  // ── E. a real EXAMPLE run saves a style (never locked by the model) ─────────────────────────────────
  let style = null;
  for (let attempt = 1; attempt <= 2 && !style; attempt++) {
    const run = await runStage(owner.token, { stage: 'example', project_id: PID, messages: msg('Make it warm and handmade — earthy colors, a friendly serif for headings. Save the style now.'), });
    const done = stageDone(run);
    info(`example run #${attempt}: status ${run.status}, ${JSON.stringify(done)?.slice(0, 200)}`);
    if (done?.ok && done.artifact?.kind === 'style_spec') style = done;
  }
  check('the AI saved a style_spec v1', style?.artifact?.version === 1, JSON.stringify(style));
  L = await latest();
  check('…and the model could NOT lock it', L.style_spec?.data?.locked === false, JSON.stringify(L.style_spec?.data ?? null).slice(0, 200));
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'build' });
  check('BUILD still blocked until the OWNER locks the style (flag:locked)', r.json?.ok === false && r.json.blocked_by?.[0]?.reason === 'flag:locked', r.text);
  r = await rpc('put_project_artifact', owner.token, { p_project: PID, p_kind: 'style_spec', p_data: { ...L.style_spec.data, locked: true }, p_expected_version: 1 });
  check('the owner locks the style (new version 2, optimistic-concurrency guard accepted)', r.status === 200 && r.json?.version === 2, r.text);
  r = await rpc('put_project_artifact', owner.token, { p_project: PID, p_kind: 'style_spec', p_data: L.style_spec.data, p_expected_version: 1 });
  check('a stale editor (expected_version 1, now 2) is refused → 409', r.status === 409, `${r.status} ${r.text}`);
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'build' });
  check('locked style → BUILD opens', r.json?.ok === true && r.json.stage === 'build', r.text);

  // ── F. editing the plan marks the style stale and closes the way forward ────────────────────────────
  r = await rpc('put_project_artifact', owner.token, { p_project: PID, p_kind: 'plan', p_data: { ...(await latest()).plan.data, name: 'Renamed ' + rand }, p_expected_version: 1 });
  check('editing the plan → plan v2, style_spec reported stale', r.json?.version === 2 && r.json.staled?.includes('style_spec'), r.text);
  L = await latest();
  check('latest view agrees: style_spec stale, plan fresh', L.style_spec?.stale === true && L.plan?.stale === false);
  r = await runStage(owner.token, { stage: 'build', project_id: PID, messages: msg('build it') });
  check('a stage run on a STALE input is refused (409, "out of date")', r.status === 409 && /out of date/i.test(r.error?.error ?? '') && r.error?.blocked_by?.[0]?.reason === 'stale', JSON.stringify(r.error));
  r = await rpc('keep_project_artifact', owner.token, { p_project: PID, p_kind: 'style_spec' });
  check('"Keep as is" clears the stale flag on the style', r.json?.cleared === true, r.text);
  r = await rpc('keep_project_artifact', owner.token, { p_project: PID, p_kind: 'launch_checks' });
  check('…but launch_checks can only be regenerated by the platform → 403', r.status === 403, `${r.status} ${r.text}`);
  r = await rpc('set_project_stage', owner.token, { p_project: PID, p_stage: 'plan' });
  check('going back to PLAN is always allowed', r.json?.ok === true && r.json.stage === 'plan', r.text);

  // ── G. resume after refresh: the browser disconnects mid-run, the result is still saved ─────────────
  const before = (await latest()).plan.version;
  const dropped = await runStage(owner.token, { stage: 'plan', project_id: PID, messages: msg('Add a gift-set product at $65 and a "Care guide" page. Save the updated plan.') }, { until: (e) => e.event === 'stage_job' });
  check('the client saw stage_job and then disconnected (a "refresh")', dropped.events.some((e) => e.event === 'stage_job'), dropped.events.map((e) => e.event).join(','));
  job = await lastJob();
  for (let i = 0; i < 10 && job?.status === 'running' && !job.heartbeat_at; i++) { await sleep(300); job = await lastJob(); } // the Worker's first heartbeat lands a few ms after stage_job
  check('right after the disconnect the job is "running" with a heartbeat (live run)', (job?.status === 'running' || job?.status === 'complete') && !!job.heartbeat_at, JSON.stringify(job));
  let final = null;
  for (let i = 0; i < 40 && !final; i++) { await sleep(2500); const j = await lastJob(); if (j && j.status !== 'running') final = j; }
  info('job after waiting: ' + JSON.stringify(final));
  check('the run FINISHED server-side without any browser attached (job complete)', final?.status === 'complete', JSON.stringify(final));
  L = await latest();
  check('…and the artifact was saved while the browser was away (plan version +1)', L.plan?.version === before + 1, `before ${before} now ${L.plan?.version}`);
  check('…so a reloaded studio would simply find it (fresh, not stale)', L.plan?.stale === false);

  // ── H. Stop ────────────────────────────────────────────────────────────────────────────────────────
  const planBeforeStop = (await latest()).plan.version;
  let jobId = null;
  await runStage(owner.token, { stage: 'plan', project_id: PID, messages: msg('Rewrite the whole plan from scratch with five pages and three products. Save it.') }, {
    until: (e) => { if (e.event === 'stage_job') { jobId = e.data.job_id; return true; } return false; },
  });
  r = await jfetch(EDGE, { method: 'POST', headers: user(owner.token), body: JSON.stringify({ stage_cancel: { job_id: jobId } }) });
  check('Stop → ai-chat closes the job (200 ok)', r.status === 200 && r.json?.ok === true, r.text);
  await sleep(1500);
  job = (await rest(`build_jobs?id=eq.${jobId}&select=status,error`, { headers: svc })).json?.[0];
  check('the job is failed with "Stopped"', job?.status === 'failed' && job.error === 'Stopped', JSON.stringify(job));
  await sleep(20000); // outlast the Worker's heartbeat (8 s) + the run itself
  const planAfterStop = (await latest()).plan.version;
  check('a stopped run saves NOTHING (plan version unchanged)', planAfterStop === planBeforeStop, `before ${planBeforeStop} after ${planAfterStop}`);
  job = (await rest(`build_jobs?id=eq.${jobId}&select=status,error`, { headers: svc })).json?.[0];
  check('…and the late Worker report did not reopen or complete the stopped job', job?.status === 'failed' && job.error === 'Stopped', JSON.stringify(job));
  r = await jfetch(EDGE, { method: 'POST', headers: user(stranger.token), body: JSON.stringify({ stage_cancel: { job_id: jobId } }) });
  check("a stranger can't stop someone else's run → 404", r.status === 404, r.text);
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  await rest(`projects?id=eq.${PID}`, { method: 'DELETE', headers: svc });
  for (const u of [owner, stranger]) if (u) await jfetch(`${SB}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: svc });
  const left = (await rest(`project_artifacts?project_id=eq.${PID}&select=id`, { headers: svc })).json?.length;
  info(`cleanup: throwaway users + project deleted (artifacts left: ${left})`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

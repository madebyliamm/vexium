#!/usr/bin/env node
// REVAMP Step 10 live evidence: the FULL BUILD Workflow against the DEPLOYED build Worker, ai-chat and database — with a stand-in for
// Anthropic (cf-worker/mock/anthropic.ts), so it costs no model credit. It proves the plumbing, not the quality of a model's pages.
//
//   1. npx wrangler deploy --config cf-worker/mock/wrangler.toml
//   2. npx wrangler deploy --config cf-worker/wrangler.toml --var ANTHROPIC_BASE_URL:https://vexium-mock-anthropic.startafter.workers.dev
//   3. node scripts/step10_build_e2e.mjs
//   4. npx wrangler deploy --config cf-worker/wrangler.toml          # back to the real Anthropic; then `wrangler delete` the mock
//
// Needs the `supabase` CLI logged in and network. Creates two throwaway users and two projects and deletes them in `finally`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emptyPlan } from '../supabase/functions/_shared/artifacts.ts';
import { EXAMPLE_CSS, HOME, STYLE } from '../supabase/tests/site_fixtures.ts';

const REPO = resolve(import.meta.dirname, '..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const EDGE = `${SB}/functions/v1/ai-chat`;
const WORKER = 'https://vexium-ai-build.startafter.workers.dev';
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-step10-e2e)' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 400)}]` : '')); };
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

const rand = Math.random().toString(36).slice(2, 8);
const mk = async (tag) => {
  const username = `vxbuild${tag}${rand}`;
  const email = `${username}@vexium.ai`;
  const password = 'Build-e2e-' + rand + '!7';
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  const id = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  return { id, token: r.json.access_token };
};

const PID = 'e2e-build-' + rand;
let owner = null, stranger = null;
try {
  owner = await mk('o');
  stranger = await mk('s');
  const mine = user(owner.token);

  // ── a project at the BUILD stage: plan + locked style + the approved example page ────────────────────
  const PLAN = {
    ...emptyPlan('Wick & Co'),
    kind: 'app', // an app: every page except home / log-in / sign-up needs a signed-in visitor
    one_liner: 'Hand-poured soy candles',
    audience: 'People who like a quiet, warm room',
    offer: 'Small-batch candles',
    pricing: { model: 'one_time', items: [{ name: 'Amber candle', price_cents: 2400 }] },
    pages: [
      { file: 'index.html', title: 'Home', purpose: 'Introduce the candles' },
      { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' },
      { file: 'contact.html', title: 'Contact', purpose: 'Get in touch mock-flaw' }, // the stand-in breaks this page on its first attempt → exercises the repair loop
      { file: 'account.html', title: 'Account', purpose: 'Your orders' },
    ],
    backend: { collections: [], products: ['Amber candle'], forms: ['contact'], auth: true },
  };
  let r = await rest('projects', { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, user_id: owner.id, name: 'Build E2E ' + rand, files: { 'index.html': HOME, 'styles.css': EXAMPLE_CSS }, main_file: 'index.html' }) });
  if (r.status >= 300) throw new Error('create project failed: ' + r.text);
  const putArtifact = (kind, data) => jfetch(`${SB}/rest/v1/rpc/put_project_artifact`, { method: 'POST', headers: svc, body: JSON.stringify({ p_project: PID, p_kind: kind, p_data: data }) });
  const latest = async () => Object.fromEntries(((await rest(`project_artifacts_latest?project_id=eq.${PID}&select=kind,version,stale,data`, { headers: mine })).json ?? []).map((a) => [a.kind, a]));
  const projectFiles = async () => (await rest(`projects?id=eq.${PID}&select=files`, { headers: svc })).json?.[0]?.files ?? {};
  const jobRow = async (id) => (await rest(`build_jobs?id=eq.${id}&select=id,status,error,heartbeat_at,finished_at,created_at`, { headers: mine })).json?.[0];
  const stepRows = async (id) => (await rest(`build_steps?job_id=eq.${id}&select=seq,kind,file,label,status,attempt,detail,cost_cents&order=seq.asc`, { headers: mine })).json ?? [];
  const start = (note, token = owner.token, project = PID) => jfetch(WORKER, { method: 'POST', headers: user(token), body: JSON.stringify({ stage: 'build', project_id: project, messages: [{ role: 'user', content: note }], stream: true }) });
  const waitJob = async (id, ms = 240000) => {
    const t0 = Date.now();
    for (;;) {
      const j = await jobRow(id);
      if (j && j.status !== 'running') return j;
      if (Date.now() - t0 > ms) return j;
      await sleep(1500);
    }
  };

  await putArtifact('plan', PLAN);
  await putArtifact('style_spec', { ...STYLE, locked: false });

  // ── A. guards (no build runs) ─────────────────────────────────────────────────────────────────────
  r = await jfetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'build', project_id: PID, messages: [{ role: 'user', content: 'Build my site' }] }) });
  check('a build without a session → 401', r.status === 401, r.text);
  r = await start('Build my site', stranger.token);
  check("a stranger can't build on someone else's project → 404", r.status === 404, r.text);
  r = await start('Build my site');
  check('an UNLOCKED style → 409 with a plain-English reason, and no job was created', r.status === 409 && r.json?.code === 'stage_inputs' && /style/i.test(r.json?.error ?? '') && ((await rest(`build_jobs?project_id=eq.${PID}&select=id`, { headers: svc })).json ?? []).length === 0, r.text);
  await putArtifact('style_spec', STYLE);
  r = await jfetch(`${SB}/rest/v1/rpc/set_project_stage`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_stage: 'build' }) });
  check('the project moves to BUILD with a plan and a locked style', r.status < 300, r.text);

  // forged operations: the build_op channel needs the Worker's secret, whoever is asking
  r = await jfetch(EDGE, { method: 'POST', headers: mine, body: JSON.stringify({ build_op: { op: 'begin', job_id: '00000000-0000-4000-8000-000000000000' } }) });
  check('build operations without the Worker secret are refused (owner session is not enough)', r.status === 401 || r.status === 403, `${r.status} ${r.text}`);
  r = await jfetch(EDGE, { method: 'POST', headers: { ...mine, 'x-vx-worker-key': 'wrong' }, body: JSON.stringify({ build_op: { op: 'complete', job_id: '00000000-0000-4000-8000-000000000000' } }) });
  check('…and so is a wrong secret', r.status === 401 || r.status === 403, `${r.status} ${r.text}`);

  // ── B. a complete build ───────────────────────────────────────────────────────────────────────────
  const filesBefore = await projectFiles();
  const before = await latest();
  const planV = before.plan?.version, styleV = before.style_spec?.version;
  r = await start('Build my site');
  const job1 = r.json?.job_id;
  check('start answers at once with the job id (the Workflow runs on by itself)', r.status === 200 && r.json?.ok === true && typeof job1 === 'string' && r.json?.stage === 'build', r.text);
  const t0 = Date.now();
  const beats = new Set();
  let sawRunning = false;
  for (;;) {
    const j = await jobRow(job1);
    if (j?.status === 'running') { sawRunning = true; if (j.heartbeat_at) beats.add(j.heartbeat_at); }
    if (!j || j.status !== 'running' || Date.now() - t0 > 240000) break;
    await sleep(2000);
  }
  const done1 = await jobRow(job1);
  const secs = Math.round((Date.now() - t0) / 1000);
  info(`build 1 ended ${done1?.status} after ${secs}s; error=${done1?.error ?? 'none'}; ${beats.size} distinct heartbeats`);
  check('build 1 completes', done1?.status === 'complete', JSON.stringify(done1));
  check('the job showed as running first and kept a heartbeat', sawRunning && beats.size >= 1, `${beats.size} heartbeats`);

  const steps1 = await stepRows(job1);
  info('steps: ' + steps1.map((s) => `${s.seq}:${s.kind}${s.file ? ':' + s.file : ''}=${s.status}`).join(' '));
  const pagesBuilt = steps1.filter((s) => s.kind === 'page');
  const plannedFiles = ['index.html', 'shop.html', 'contact.html', 'account.html', 'login.html', 'signup.html'];
  check('the checklist has a step per page (the plan’s four plus log-in and sign-up for a site with accounts), all done',
    plannedFiles.every((f) => pagesBuilt.some((s) => s.file === f && s.status === 'done')) && pagesBuilt.length === plannedFiles.length, JSON.stringify(pagesBuilt.map((s) => [s.file, s.status])));
  check('prepare, verify and save are done too', ['prepare', 'verify', 'save'].every((k) => steps1.some((s) => s.kind === k && s.status === 'done')), JSON.stringify(steps1.filter((s) => s.kind !== 'page').map((s) => [s.kind, s.status])));
  const fixes = steps1.filter((s) => s.kind === 'fix');
  check('the verifier caught the broken contact page and the repair loop fixed it', fixes.some((s) => s.file === 'contact.html' && s.status === 'done'), JSON.stringify(fixes));

  const files = await projectFiles();
  check('every page, the shared files and the backend rules are saved', [...plannedFiles, 'styles.css', 'site.js', 'manifest.json', '_backend'].every((f) => typeof files[f] === 'string' && files[f].length > 20), Object.keys(files).join(','));
  check('the contact page is the repaired one (no dead link)', !files['contact.html']?.includes('missing-page.html') && files['contact.html']?.includes('data-vx-form="contact"'));
  check('the product has its buy button on the shop page and in the backend rules', files['shop.html']?.includes('data-vx-buy="amber-candle"') && /amber-candle/.test(files['_backend'] ?? ''), (files['_backend'] ?? '').slice(0, 200));
  check('the home page replaced the example', files['index.html'] !== HOME && files['index.html']?.includes('Home'));
  check('the log-in page signs visitors in and the account page needs sign-in', files['login.html']?.includes('data-vx-auth="login"') && files['account.html']?.includes('data-vx-require-auth'));
  check('no page contains placeholder text', plannedFiles.every((f) => !/lorem ipsum|your text here|coming soon|example\.com|\bTODO\b/i.test(files[f] ?? '')));

  const a1 = await latest();
  const manifest = a1.manifest, report = a1.launch_checks;
  check('a manifest artifact lists the pages, the shared files and the backend', manifest?.version === 1 && manifest.data.pages.length === 6 && manifest.data.shared_files.includes('styles.css') && manifest.data.backend.products.length === 1 && manifest.data.backend.forms.includes('contact') && manifest.data.backend.auth === true, JSON.stringify(manifest?.data).slice(0, 300));
  const stepCost = steps1.reduce((n, s) => n + Number(s.cost_cents ?? 0), 0);
  check('the build cost is recorded: per step, and as the manifest total (≈ the sum of the steps)', manifest?.data.cost_cents > 0 && stepCost > 0 && Math.abs(manifest.data.cost_cents - stepCost) <= 1, `manifest ${manifest?.data.cost_cents}¢, steps ${stepCost}¢`);
  check('a passing launch report is saved against that manifest version', report?.data.ok === true && report.data.manifest_version === manifest?.version && report.data.checks.every((c) => c.status !== 'fail'), JSON.stringify(report?.data).slice(0, 300));
  check('the report says what only the owner can supply instead of faking it', Array.isArray(report?.data.open_items));
  check('the plan and the style were not touched by the build (same versions, not out of date)', a1.plan?.version === planV && a1.style_spec?.version === styleV && !a1.plan.stale && !a1.style_spec.stale, `plan v${a1.plan?.version}/${planV}, style v${a1.style_spec?.version}/${styleV}`);
  check('the files before the build were replaced atomically (example page and stylesheet are now the built ones)', files['styles.css'] !== filesBefore['styles.css'] && files['styles.css'].includes('--accent'));

  // who can read what
  const withOutput = await rest(`build_steps?job_id=eq.${job1}&select=output`, { headers: mine });
  check("page text in build_steps is not readable by the owner's browser", withOutput.status >= 400 || (withOutput.json ?? []).every((x) => x.output == null), `${withOutput.status} ${withOutput.text.slice(0, 120)}`);
  const foreign = await rest(`build_steps?job_id=eq.${job1}&select=seq`, { headers: user(stranger.token) });
  check("a stranger can't see the checklist", Array.isArray(foreign.json) && foreign.json.length === 0, foreign.text.slice(0, 120));
  const foreignJob = await rest(`build_jobs?id=eq.${job1}&select=id`, { headers: user(stranger.token) });
  check("…or the job", Array.isArray(foreignJob.json) && foreignJob.json.length === 0);

  // "Check again" re-runs the verifier on the saved site and saves a fresh report
  r = await jfetch(EDGE, { method: 'POST', headers: mine, body: JSON.stringify({ stage: 'build', build_recheck: { project_id: PID } }) });
  const a1b = await latest();
  check('"Check again" saves a new report (version 2) for the same manifest', r.status === 200 && r.json?.ok === true && a1b.launch_checks?.version === 2 && a1b.launch_checks.data.manifest_version === manifest?.version && a1b.launch_checks.data.ok === true, r.text.slice(0, 200));
  r = await jfetch(EDGE, { method: 'POST', headers: user(stranger.token), body: JSON.stringify({ stage: 'build', build_recheck: { project_id: PID } }) });
  check("a stranger can't trigger it → 404", r.status === 404, r.text.slice(0, 160));

  // ── C. Stop during a build: nothing is committed ──────────────────────────────────────────────────
  const filesStable = await projectFiles();
  r = await start('mock-slow');
  const job2 = r.json?.job_id;
  check('a second build starts (the note reaches every page)', r.status === 200 && typeof job2 === 'string', r.text);
  let parallel = 0;
  for (let i = 0; i < 20 && parallel < 4; i++) {
    await sleep(1500);
    parallel = (await stepRows(job2)).filter((s) => s.kind === 'page' && s.status === 'running').length;
  }
  check('its checklist shows pages being written in parallel (4 at a time)', parallel === 4, `${parallel} running`);
  const beat1 = (await jobRow(job2))?.heartbeat_at;
  await sleep(10000);
  const beat2 = (await jobRow(job2))?.heartbeat_at;
  check('the heartbeat keeps moving while the pages are being written', !!beat1 && !!beat2 && beat2 !== beat1, `${beat1} → ${beat2}`);
  r = await jfetch(EDGE, { method: 'POST', headers: user(stranger.token), body: JSON.stringify({ stage_cancel: { job_id: job2 } }) });
  check("a stranger can't stop it", r.status === 404 || r.status === 403, r.text.slice(0, 160));
  r = await jfetch(EDGE, { method: 'POST', headers: mine, body: JSON.stringify({ stage_cancel: { job_id: job2 } }) });
  check('the owner can stop it', r.status === 200, r.text.slice(0, 160));
  const stopped = await waitJob(job2, 60000);
  check('the job ends as stopped (failed with a plain reason)', stopped?.status === 'failed' && /stop/i.test(stopped.error ?? ''), JSON.stringify(stopped));
  await sleep(8000);
  const filesAfterStop = await projectFiles();
  const a2 = await latest();
  check('nothing was committed: same files, same manifest version', JSON.stringify(filesAfterStop) === JSON.stringify(filesStable) && a2.manifest?.version === 1, `manifest v${a2.manifest?.version}`);
  const steps2 = await stepRows(job2);
  check('the stopped run leaves no step "running"', !steps2.some((s) => s.status === 'running'), JSON.stringify(steps2.map((s) => [s.seq, s.status])));

  // ── D. the AI service refuses (out of credit): a plain failure, nothing committed ─────────────────
  r = await start('mock-credit');
  const job3 = r.json?.job_id;
  const failed3 = job3 ? await waitJob(job3, 120000) : null;
  check('an out-of-credit AI service fails the build with words the owner can read', failed3?.status === 'failed' && /credit|AI service|try again/i.test(failed3.error ?? '') && !/anthropic|balance|api key/i.test(failed3.error ?? ''), JSON.stringify(failed3));
  const a3 = await latest();
  check('…and nothing was committed', JSON.stringify(await projectFiles()) === JSON.stringify(filesStable) && a3.manifest?.version === 1);

  // ── E. rebuild: the new build replaces the old atomically ─────────────────────────────────────────
  r = await start('Build my site again, a little warmer');
  const job4 = r.json?.job_id;
  const done4 = job4 ? await waitJob(job4, 240000) : null;
  const a4 = await latest();
  check('a rebuild completes and saves manifest version 2 with a fresh passing report', done4?.status === 'complete' && a4.manifest?.version === 2 && a4.launch_checks?.data.manifest_version === 2 && a4.launch_checks.data.ok === true, JSON.stringify([done4, a4.manifest?.version, a4.launch_checks?.version]));
  const count = (await rest(`build_jobs?project_id=eq.${PID}&stage=eq.build&select=id`, { headers: svc })).json?.length;
  check('one job row per run (4 runs, none duplicated)', count === 4, String(count));
} catch (e) {
  fail++;
  console.log('FAIL unexpected error: ' + (e?.stack ?? e));
} finally {
  for (const u of [owner, stranger]) {
    if (u) await jfetch(`${SB}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: svc }).catch(() => {});
  }
  await rest(`projects?id=eq.${PID}`, { method: 'DELETE', headers: svc }).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

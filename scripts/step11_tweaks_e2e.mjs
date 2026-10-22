#!/usr/bin/env node
// REVAMP Step 11 live evidence: TWEAKS (point at an element, say what to change) + site history (undo / redo / restore) against the
// DEPLOYED build Worker, ai-chat and database — with a stand-in for Anthropic (cf-worker/mock/anthropic.ts), so it costs no model credit.
// It proves the plumbing and the safety rules, not the quality of a model's edits.
//
//   1. npx wrangler deploy --config cf-worker/mock/wrangler.toml
//   2. npx wrangler deploy --config cf-worker/wrangler.toml --var ANTHROPIC_BASE_URL:https://vexium-mock-anthropic.startafter.workers.dev
//   3. node scripts/step11_tweaks_e2e.mjs
//   4. npx wrangler deploy --config cf-worker/wrangler.toml          # back to the real Anthropic; then `wrangler delete` the mock
//
// Needs the `supabase` CLI logged in and network. Creates two throwaway users and one project and deletes them in `finally`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtSite, FULL_STYLE, PLAN } from '../supabase/tests/built_site.ts';

const REPO = resolve(import.meta.dirname, '..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const EDGE = `${SB}/functions/v1/ai-chat`;
const WORKER = 'https://vexium-ai-build.startafter.workers.dev';
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-step11-e2e)' };

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

/** POST a stage run to the Worker and read its event stream to the end. A refusal comes back as JSON with a status. */
async function runStage(body, token) {
  const res = await fetch(WORKER, { method: 'POST', headers: { ...UA, ...user(token) }, body: JSON.stringify({ ...body, stream: true }) });
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, events: [], done: null };
  }
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev) { let d = null; try { d = JSON.parse(data ?? 'null'); } catch { /* keep null */ } events.push({ event: ev, data: d }); }
    }
  }
  return { status: res.status, json: null, text: '', events, done: events.find((e) => e.event === 'stage_done')?.data ?? null };
}

const rand = Math.random().toString(36).slice(2, 8);
const mk = async (tag) => {
  const username = `vxtweak${tag}${rand}`;
  const email = `${username}@vexium.ai`;
  const password = 'Tweak-e2e-' + rand + '!7';
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  const id = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  return { id, token: r.json.access_token };
};

const PID = 'e2e-tweaks-' + rand;
let owner = null, stranger = null;
try {
  owner = await mk('o');
  stranger = await mk('s');
  const mine = user(owner.token);
  const { files: BUILT, manifest: MANIFEST } = builtSite();
  const LIVE = { 'index.html': '<!DOCTYPE html><html><body><h1>The live site</h1></body></html>' };

  // ── a project at TWEAKS: plan + locked style + the built site + a published copy that must never move ──
  let r = await rest('projects', { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, user_id: owner.id, name: 'Tweaks E2E ' + rand, files: BUILT, main_file: 'index.html', published_files: LIVE, published_slug: 'e2e-' + rand, published_at: new Date().toISOString(), published_version: 1 }) });
  if (r.status >= 300) throw new Error('create project failed: ' + r.text);
  const put = (kind, data) => jfetch(`${SB}/rest/v1/rpc/put_project_artifact`, { method: 'POST', headers: svc, body: JSON.stringify({ p_project: PID, p_kind: kind, p_data: data }) });
  const latest = async () => Object.fromEntries(((await rest(`project_artifacts_latest?project_id=eq.${PID}&select=kind,version,stale,data`, { headers: mine })).json ?? []).map((a) => [a.kind, a]));
  const row = async () => (await rest(`projects?id=eq.${PID}&select=files,stage,published_files,published_at,published_version,published_slug`, { headers: svc })).json?.[0] ?? {};
  const siteFiles = async () => (await row()).files ?? {};
  const versions = async () => (await rest(`site_snapshots?project_id=eq.${PID}&select=seq,kind,label,is_current&order=seq`, { headers: mine })).json ?? [];
  const chat = async () => (await rest(`stage_messages?project_id=eq.${PID}&stage=eq.tweaks&select=role,content,job_id&order=created_at.asc`, { headers: mine })).json ?? [];
  const history = (action, seq, token = owner.token) => jfetch(EDGE, { method: 'POST', headers: user(token), body: JSON.stringify({ tweaks_history: { project_id: PID, action, ...(seq === undefined ? {} : { seq }) } }) });
  const tweak = (content, extra = {}, token = owner.token, project = PID) => runStage({ stage: 'tweaks', project_id: project, messages: [{ role: 'user', content }], ...extra }, token);
  const changedFiles = (a, b) => Object.keys({ ...a, ...b }).filter((f) => a[f] !== b[f]).sort();

  const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(BUILT['index.html']);
  const H1_TEXT = h1[1].trim();
  const POINTED = { page: 'index.html', selector: 'h1', tag: 'h1', text: H1_TEXT, html: h1[0] };

  // ── A. guards ─────────────────────────────────────────────────────────────────────────────────────
  await put('plan', PLAN);
  await put('style_spec', FULL_STYLE);
  r = await tweak('mock-say "Nope"', { pointed: POINTED });
  check('no built site yet (plan + style but no manifest) → 409 with a plain reason, and no job', r.status === 409 && r.json?.code === 'stage_inputs' && /built site/i.test(r.json?.error ?? ''), r.text);
  await put('manifest', MANIFEST);
  r = await jfetch(`${SB}/rest/v1/rpc/set_project_stage`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_stage: 'tweaks' }) });
  check('the project moves to TWEAKS once a site is built (stage engine)', r.status < 300 && (await row()).stage === 'tweaks', r.text);
  check('nothing has been recorded yet: no jobs, no versions, no chat', ((await rest(`build_jobs?project_id=eq.${PID}&select=id`, { headers: svc })).json ?? []).length === 0 && (await versions()).length === 0 && (await chat()).length === 0);

  r = await runStage({ stage: 'tweaks', project_id: PID, messages: [{ role: 'user', content: 'x' }] }, 'not-a-token');
  check('a change without a valid session → 401', r.status === 401, r.text);
  r = await tweak('mock-say "Nope"', { pointed: POINTED }, stranger.token);
  check("a stranger can't change someone else's site → 404", r.status === 404, r.text);
  r = await tweak('make it nicer', { pointed: { page: 'index.html', selector: 'h1', tag: '<script>' } });
  check('a malformed pointed element → 400 bad_pointed', r.status === 400 && r.json?.code === 'bad_pointed', r.text);
  r = await tweak('make it nicer', { pointed: { page: 'not a page.html', selector: 'h1', tag: 'h1', text: 'x', html: '<h1>x</h1>' } });
  check('a pointed element on a page that is not a file name → 400 bad_pointed', r.status === 400 && r.json?.code === 'bad_pointed', r.text);
  r = await runStage({ stage: 'tweaks', project_id: PID, messages: [{ role: 'assistant', content: 'hi' }] }, owner.token);
  check('a conversation that does not end with the owner → 400', r.status === 400, r.text);
  check('history: a stranger cannot move it → 404; a bad action → 400; a restore with no version → 400', (await history('undo', undefined, stranger.token)).status === 404 && (await history('sideways')).status === 400 && (await history('restore')).status === 400);
  r = await history('undo');
  check('history: nothing saved yet → says so in plain words (200, not moved)', r.status === 200 && r.json?.moved === false && r.json?.reason === 'no_history' && /no saved versions/i.test(r.json?.error ?? ''), r.text);
  check('none of the refusals left a job, a version or a chat line', ((await rest(`build_jobs?project_id=eq.${PID}&select=id`, { headers: svc })).json ?? []).length === 0 && (await versions()).length === 0 && (await chat()).length === 0);

  // ── B. words: point at the headline and say what it should say ─────────────────────────────────────
  const files0 = await siteFiles();
  const NEW_WORDS = 'Hand-poured candles, made slowly';
  r = await tweak(`mock-say "${NEW_WORDS}"`, { pointed: POINTED });
  const done1 = r.done;
  info('events: ' + [...new Set(r.events.map((e) => e.event))].join(','));
  const errEvent = r.events.find((e) => e.event === 'error');
  if (errEvent) info('error event: ' + JSON.stringify(errEvent.data).slice(0, 500));
  check('the run starts (stage_job first), streams the answer, and ends with stage_done ok', r.status === 200 && r.events[0]?.event === 'stage_job' && r.events.some((e) => e.event === 'delta') && done1?.ok === true, JSON.stringify(done1) + ' ' + r.text.slice(0, 200));
  check('stage_done names the file that changed — only the page', JSON.stringify(done1?.changed) === JSON.stringify(['index.html']), JSON.stringify(done1));
  const files1 = await siteFiles();
  check('the headline has the new words and the old ones are gone from that heading', files1['index.html'].includes(`>${NEW_WORDS}<`) && !files1['index.html'].includes(`>${H1_TEXT}<`), (/<h1[^>]*>[^<]*<\/h1>/.exec(files1['index.html']) ?? [''])[0]);
  check('every other file is byte-for-byte what it was (including the uploaded image and the backend rules)', JSON.stringify(changedFiles(files0, files1)) === JSON.stringify(['index.html']), changedFiles(files0, files1).join());
  const a1 = await latest();
  check('the launch report was re-run on the changed site and belongs to the current manifest; nothing is out of date', a1.launch_checks?.data.manifest_version === a1.manifest?.version && !a1.manifest.stale && !a1.launch_checks.stale && !a1.style_spec.stale && !a1.plan.stale, JSON.stringify({ r: a1.launch_checks?.data.manifest_version, m: a1.manifest?.version }));
  const v1 = await versions();
  check('history: "Before your changes" was saved first, then the change itself — and the change is where the site is now', v1.length === 2 && v1[0].kind === 'baseline' && v1[0].label === 'Before your changes' && v1[1].kind === 'tweak' && v1[1].is_current && !v1[0].is_current && v1[1].label.startsWith('Mock-say'), JSON.stringify(v1));
  const c1 = await chat();
  check('the conversation is stored: the owner\'s words, then a plain answer with no edit markup', c1.length === 2 && c1[0].role === 'user' && c1[0].content.includes(NEW_WORDS) && c1[1].role === 'assistant' && c1[1].content.length > 3 && !/<patch|<find|<replace|\[\[/.test(c1[1].content), JSON.stringify(c1).slice(0, 300));
  check('both lines belong to the run (same job)', !!c1[0]?.job_id && c1[0].job_id === c1[1]?.job_id);
  const p1 = await row();
  check('EDITS STAY A DRAFT: the published copy, its version and its address did not move', JSON.stringify(p1.published_files) === JSON.stringify(LIVE) && p1.published_version === 1 && p1.published_slug === 'e2e-' + rand);
  const job1 = (await rest(`build_jobs?project_id=eq.${PID}&stage=eq.tweaks&select=status,error,artifact_kind&order=created_at.asc`, { headers: mine })).json ?? [];
  check('the run is recorded as complete', job1.length === 1 && job1[0].status === 'complete', JSON.stringify(job1));

  // ── C. a question is not an edit ───────────────────────────────────────────────────────────────────
  r = await tweak('what else could I change?', { pointed: POINTED });
  check('a question gets an answer: ok, no changed files', r.done?.ok === true && !(r.done.changed?.length), JSON.stringify(r.done));
  check('…the site and the versions are untouched, and the chat has grown by two lines', JSON.stringify(await siteFiles()) === JSON.stringify(files1) && (await versions()).length === 2 && (await chat()).length === 4);

  // ── D. changes the platform must refuse, whole ─────────────────────────────────────────────────────
  const refuse = async (words, label, expectError) => {
    const jobs = ((await rest(`build_jobs?project_id=eq.${PID}&stage=eq.tweaks&select=id`, { headers: svc })).json ?? []).length;
    const res = await tweak(words, { pointed: POINTED });
    const err = res.done?.error ?? '';
    check(label + ': refused with a plain reason', res.status === 200 && res.done?.ok === false && expectError.test(err) && !/patch|find|regex|stack|undefined/i.test(err), JSON.stringify(res.done));
    check(label + ': nothing at all was written (files, versions, report)', JSON.stringify(await siteFiles()) === JSON.stringify(files1) && (await versions()).length === 2 && JSON.stringify((await latest()).launch_checks?.version) === JSON.stringify(a1.launch_checks.version), '');
    check(label + ': the run is closed as failed, and the owner\'s line was kept', ((await rest(`build_jobs?project_id=eq.${PID}&stage=eq.tweaks&select=id,status`, { headers: svc })).json ?? []).length === jobs + 1);
  };
  await refuse('mock-bad-find please', 'an edit that does not match the page', /.+/);
  await refuse('mock-hook please', 'an edit that would rename a form field', /.+/);

  // ── E. colour: no pointing, the whole site ─────────────────────────────────────────────────────────
  const files1b = await siteFiles();
  r = await tweak('mock-accent #2f7d4f');
  check('a colour change is made', r.done?.ok === true && JSON.stringify(r.done.changed) === JSON.stringify(['styles.css']) || (r.done?.ok === true && r.done.changed?.includes('styles.css')), JSON.stringify(r.done));
  const files2 = await siteFiles();
  const a2 = await latest();
  check('the stylesheet has the new accent', /--accent:\s*#2f7d4f/i.test(files2['styles.css']) && !/--accent:\s*#2f7d4f/i.test(files1b['styles.css']));
  check('the saved style follows (new accent, still locked), the manifest and the report were re-saved, and nothing is out of date', a2.style_spec.data.tokens?.['--accent']?.toLowerCase() === '#2f7d4f' && a2.style_spec.data.locked === true && !a2.style_spec.stale && !a2.manifest.stale && a2.launch_checks.data.manifest_version === a2.manifest.version && a2.manifest.version > a1.manifest.version, JSON.stringify({ accent: a2.style_spec.data.tokens?.['--accent'], locked: a2.style_spec.data.locked, stale: [a2.style_spec.stale, a2.manifest.stale], m: a2.manifest.version, r: a2.launch_checks.data.manifest_version }));
  check('manifest.json (the install colours) follows the new accent', JSON.parse(files2['manifest.json'] ?? '{}').theme_color?.toLowerCase() === '#2f7d4f', files2['manifest.json']);
  check('only the style files changed; pages and site.js are as they were', changedFiles(files1b, files2).every((f) => ['styles.css', 'manifest.json'].includes(f)) && files2['index.html'] === files1b['index.html'] && files2['site.js'] === files1b['site.js'], changedFiles(files1b, files2).join());
  const v2 = await versions();
  check('history: a third version, current', v2.length === 3 && v2[2].kind === 'tweak' && v2[2].is_current, JSON.stringify(v2));

  // ── F. undo / redo / restore ───────────────────────────────────────────────────────────────────────
  r = await history('undo');
  check('undo: moves back one version (to the words change) and says which', r.status === 200 && r.json?.moved === true && r.json.seq === v2[1].seq && typeof r.json.label === 'string', r.text.slice(0, 200));
  const files3 = await siteFiles();
  const a3 = await latest();
  check('…the site files are exactly those of that version', JSON.stringify(files3) === JSON.stringify(files1b) || changedFiles(files3, files1b).every((f) => f === 'manifest.json'), changedFiles(files3, files1b).join());
  check('…the saved style followed the stylesheet back, and the report was refreshed (checked)', r.json?.checked === true && a3.style_spec.data.tokens?.['--accent']?.toLowerCase() !== '#2f7d4f' && a3.launch_checks.data.manifest_version === a3.manifest.version && !a3.manifest.stale, JSON.stringify({ checked: r.json?.checked, accent: a3.style_spec.data.tokens?.['--accent'] }));
  r = await history('undo');
  check('undo again: back to the site as it was before any change ("Before your changes")', r.json?.moved === true && r.json.seq === v2[0].seq && r.json.kind === 'baseline', r.text.slice(0, 200));
  check('…exactly the original files (the whole site, byte for byte)', changedFiles(await siteFiles(), files0).every((f) => f === 'manifest.json'), changedFiles(await siteFiles(), files0).join());
  r = await history('undo');
  check('undo at the oldest version says so and moves nothing', r.status === 200 && r.json?.moved === false && /oldest/i.test(r.json.error ?? ''), r.text);
  r = await history('redo');
  check('redo: forward again, to the words', r.json?.moved === true && (await siteFiles())['index.html'] === files1['index.html'], r.text.slice(0, 200));
  r = await history('restore', v2[2].seq);
  check('restore: straight to the colour version', r.json?.moved === true && /--accent:\s*#2f7d4f/i.test((await siteFiles())['styles.css']), r.text.slice(0, 200));
  r = await history('redo');
  check('redo at the newest version says so and moves nothing', r.json?.moved === false && /newest/i.test(r.json.error ?? ''), r.text);
  r = await history('restore', v2[2].seq);
  check('restore to the version you are already on says so', r.json?.moved === false && /already/i.test(r.json.error ?? ''), r.text);
  r = await history('restore', 9999);
  check('restore to a version that does not exist says so', r.json?.moved === false && /no longer saved/i.test(r.json.error ?? ''), r.text);
  const p2 = await row();
  check('EDITS STAY A DRAFT through every undo, redo and restore: the published copy never moved', JSON.stringify(p2.published_files) === JSON.stringify(LIVE) && p2.published_version === 1 && p2.stage === 'tweaks');

  // a new change after going back drops what was ahead; the line stays a line
  await history('restore', v2[0].seq);
  r = await tweak('mock-accent #8a3b12');
  const v3 = await versions();
  check('a new change from an earlier version replaces the versions that were ahead of it (baseline + the new one)', r.done?.ok === true && v3.length === 2 && v3[1].is_current && v3.every((v, i) => v.seq === v3[0].seq + i), JSON.stringify(v3));

  // ── G. Stop, and a version move while a change is being made ───────────────────────────────────────
  const files4 = await siteFiles();
  const slowRun = tweak(`mock-slow mock-say "A slower headline"`, { pointed: POINTED });
  let jobId = null;
  for (let i = 0; i < 20 && !jobId; i++) {
    await sleep(700);
    jobId = ((await rest(`build_jobs?project_id=eq.${PID}&stage=eq.tweaks&status=eq.running&select=id`, { headers: mine })).json ?? [])[0]?.id ?? null;
  }
  check('a slow change shows as a running job', !!jobId);
  r = await jfetch(EDGE, { method: 'POST', headers: user(stranger.token), body: JSON.stringify({ stage_cancel: { job_id: jobId } }) });
  check("a stranger can't stop it", r.status === 404 || r.status === 403, r.text.slice(0, 120));
  r = await jfetch(EDGE, { method: 'POST', headers: mine, body: JSON.stringify({ stage_cancel: { job_id: jobId } }) });
  check('the owner can stop it', r.status === 200, r.text.slice(0, 120));
  const slow = await slowRun;
  await sleep(2500);
  const stopped = (await rest(`build_jobs?id=eq.${jobId}&select=status,error`, { headers: mine })).json?.[0];
  check('Stop: the run is closed as stopped and NOTHING is half-applied (same files, same versions)', stopped?.status === 'failed' && /stop/i.test(stopped.error ?? '') && JSON.stringify(await siteFiles()) === JSON.stringify(files4) && (await versions()).length === v3.length, JSON.stringify({ stopped, done: slow.done }));

  const slow2 = tweak(`mock-slow mock-say "Another headline"`, { pointed: POINTED });
  let jobId2 = null;
  for (let i = 0; i < 20 && !jobId2; i++) {
    await sleep(700);
    jobId2 = ((await rest(`build_jobs?project_id=eq.${PID}&stage=eq.tweaks&status=eq.running&select=id`, { headers: mine })).json ?? [])[0]?.id ?? null;
  }
  r = await history('undo');
  check('moving to another version while a change is being made closes that change first (so it cannot land on top)', r.status === 200 && (r.json?.moved === true || r.json?.reason === 'nothing_to_undo'), r.text.slice(0, 200));
  await slow2;
  await sleep(2500);
  const closed = (await rest(`build_jobs?id=eq.${jobId2}&select=status,error`, { headers: mine })).json?.[0];
  check('…the interrupted change was NOT applied afterwards', closed?.status === 'failed' && !(await siteFiles())['index.html'].includes('Another headline'), JSON.stringify(closed));

  // ── H. who can read and write what ─────────────────────────────────────────────────────────────────
  const foreign = await rest(`site_snapshots?project_id=eq.${PID}&select=seq`, { headers: user(stranger.token) });
  check("a stranger can't see the saved versions", Array.isArray(foreign.json) && foreign.json.length === 0, foreign.text.slice(0, 120));
  const cols = await rest(`site_snapshots?project_id=eq.${PID}&select=files`, { headers: mine });
  check("the owner's browser can list versions but NOT read their file contents directly", cols.status >= 400 || (cols.json ?? []).every((x) => x.files == null), `${cols.status} ${cols.text.slice(0, 120)}`);
  r = await rest('site_snapshots', { method: 'POST', headers: { ...mine, Prefer: 'return=minimal' }, body: JSON.stringify({ project_id: PID, seq: 99, kind: 'tweak', label: 'forged', files: {}, is_current: true }) });
  check("the owner's browser can't write versions", r.status >= 400, `${r.status}`);
  r = await jfetch(`${SB}/rest/v1/rpc/move_site_history`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_action: 'restore', p_seq: 1 }) });
  check('…or call the history functions directly (only the platform can)', r.status >= 400, `${r.status} ${r.text.slice(0, 100)}`);
  r = await jfetch(`${SB}/rest/v1/rpc/take_site_snapshot`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_kind: 'tweak', p_label: 'x' }) });
  check('…or take a snapshot', r.status >= 400, `${r.status} ${r.text.slice(0, 100)}`);

  // a stale style (the plan changed after it was set) blocks changes until the owner decides
  await put('plan', { ...PLAN, name: 'Wick & Co (edited)' });
  r = await tweak('mock-say "Blocked"', { pointed: POINTED });
  check('a plan edited after the style was set (style out of date) → 409 with a plain reason; nothing written', r.status === 409 && r.json?.code === 'stage_inputs' && JSON.stringify(await siteFiles()) !== '' && !(await siteFiles())['index.html'].includes('Blocked'), r.text.slice(0, 200));
  await jfetch(`${SB}/rest/v1/rpc/keep_project_artifact`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_kind: 'style_spec' }) });
  await jfetch(`${SB}/rest/v1/rpc/keep_project_artifact`, { method: 'POST', headers: mine, body: JSON.stringify({ p_project: PID, p_kind: 'manifest' }) });
  r = await tweak('mock-say "Allowed again"', { pointed: POINTED });
  check('once the owner keeps the style and the site as they are, changes work again', r.done?.ok === true, r.text.slice(0, 200) + JSON.stringify(r.done));
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

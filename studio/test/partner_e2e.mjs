#!/usr/bin/env node
// Step 13 (chunk C) evidence: the AI business partner on the BUSINESS screen, in a real (headless) Chrome against the REAL `business-partner`
// and `business-state` functions, database and (for Apply) the TWEAKS pipeline. A throwaway user and two live projects with seeded traffic.
//
//   (cd studio && npm run build) && node scripts/assemble-site.mjs      # produce _site/
//   node studio/test/partner_e2e.mjs                                    # serves _site/ and tests that, WITHOUT a model: the polite-failure path
//   E2E_MOCK=1 node studio/test/partner_e2e.mjs                         # the full flow, with the mock model (see docs/INFRA.md "Testing the business partner")
//   E2E_BASE=https://vexium.ai node studio/test/partner_e2e.mjs         # tests the deployed studio instead
//
// E2E_MOCK=1 needs BOTH: the `business-partner` secret ANTHROPIC_BASE_URL and the build Worker's ANTHROPIC_BASE_URL var pointing at the
// `mock-anthropic` edge function (Apply runs a real TWEAKS change through the build Worker). Restore both afterwards.
// Needs Google Chrome, the `supabase` CLI logged in (service key), network. Everything it creates is deleted in `finally`.
// Screenshots: /tmp/studio-e2e/partner-*.png. Use dangerouslyDisableSandbox with the Bash tool.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { launch } from '../../sdk/test/cdp.mjs';
import { builtSite, FULL_STYLE, PLAN } from '../../supabase/tests/built_site.ts';

const REPO = resolve(import.meta.dirname, '../..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const OUT = '/tmp/studio-e2e';
const MOCK = process.env.E2E_MOCK === '1';
mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-partner-e2e)' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 300)}]` : '')); };
const info = (m) => console.log('INFO ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveSite(dir) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = normalize(join(dir, p));
    if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
async function jfetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const svcKey = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { encoding: 'utf8' }))
  .find((k) => k.name === 'service_role' || k.id === 'service_role').api_key;
const svc = { apikey: svcKey, Authorization: 'Bearer ' + svcKey };
const J = { ...svc, 'Content-Type': 'application/json' };

const rand = Math.random().toString(36).slice(2, 8);
const username = `vxptui${rand}`;
const email = `${username}@vexium.ai`;
const password = 'Partner-ui-e2e-' + rand + '!9';
const PID = 'e2e-pt-' + rand;          // a shop with real numbers
const PID_EARLY = 'e2e-pt-e-' + rand;  // live, five visitors
const NAME = 'Wick & Co';
const SLUG = `wick-${rand}`;
const iso = (daysAgo, h = 12) => new Date(Date.now() - daysAgo * 86400e3 + (h - 12) * 3600e3).toISOString();
const { files: BUILT, manifest: MANIFEST } = builtSite();
const LIVE = { 'index.html': '<!DOCTYPE html><html><body><h1>The live site</h1></body></html>' };

let uid = null, chrome = null, local = null;
try {
  // ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: J, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  uid = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  const SESSION = r.json;

  const rest = (path, init = {}) => jfetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...J, Prefer: 'return=minimal', ...(init.headers || {}) } });
  const post = (path, body) => rest(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => rest(path, { method: 'PATCH', body: JSON.stringify(body) });
  const rpc = (name, body) => jfetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  const put = async (pid, kind, data) => (await rpc('put_project_artifact', { p_project: pid, p_kind: kind, p_data: data })).json?.version;

  for (const [pid, slug] of [[PID, SLUG], [PID_EARLY, SLUG + '-e']]) {
    r = await post('projects', { id: pid, user_id: uid, name: NAME, emoji: '🕯️', files: BUILT, main_file: 'index.html', published_files: LIVE, published_slug: slug, published_version: 1, published_at: iso(10), is_public: true, stage: 'business' });
    if (r.status >= 300) throw new Error('create project failed: ' + r.text);
    r = await post('project_deploys', { project_id: pid, version: 1, status: 'ready', created_by: uid, created_at: iso(10) });
    if (r.status >= 300) throw new Error('create deploy failed: ' + r.text);
  }
  await put(PID, 'plan', PLAN);
  await put(PID, 'style_spec', FULL_STYLE);
  const mv = await put(PID, 'manifest', MANIFEST);
  await put(PID, 'launch_checks', { schema: 1, checked_at: new Date().toISOString(), manifest_version: mv, ok: true, checks: [{ id: 'pages', label: 'Every page was built', status: 'pass' }], open_items: [] });

  // 60 visitors over the last 9 days (a week-plus of data → "ok"), 3 sales.
  const views = [];
  for (let i = 0; i < 60; i++) views.push({ project_id: PID, page: i % 3 ? '/' : '/shop.html', referrer: i % 2 ? 'https://www.google.com/' : '', device: i % 4 ? 'mobile' : 'desktop', session_id: 's' + i, visitor_id: 'v' + i, ts: iso(1 + (i % 9), 8 + (i % 8)) });
  await post('page_views', views);
  await post('site_data', [
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 24, currency: 'usd', status: 'paid', description: 'Candle' }, created_at: iso(2) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 24, currency: 'usd', status: 'paid', description: 'Candle' }, created_at: iso(3) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 24, currency: 'usd', status: 'paid', description: 'Candle' }, created_at: iso(4) },
  ]);
  const early = [];
  for (let i = 0; i < 5; i++) early.push({ project_id: PID_EARLY, page: '/', referrer: '', device: 'mobile', session_id: 'e' + i, visitor_id: 'e' + i, ts: iso(1, 10 + i) });
  await post('page_views', early);
  await patch(`projects?id=eq.${PID}`, { published_at: new Date().toISOString() });
  const lastWrite = Date.now(); // the screen only says "changes not live yet" when the draft is > 30 s newer than the live copy

  let base = process.env.E2E_BASE;
  if (!base) {
    const dir = join(REPO, '_site');
    if (!existsSync(join(dir, 'studio/index.html'))) throw new Error('_site/ not found — run the build + node scripts/assemble-site.mjs first');
    local = await serveSite(dir);
    base = local.base;
  }
  info(`testing ${base} (${MOCK ? 'mock model' : 'no model: polite-failure path'})`);
  const STORAGE_KEY = `sb-${REF}-auth-token`;

  chrome = await launch();
  if (!chrome) throw new Error('Chrome not found (set CHROME_BIN)');
  await chrome.viewport(1280, 1100);
  await chrome.goto(base + '/vertly_mark.svg');
  await chrome.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(SESSION))}); true`);
  chrome.consoleMsgs.length = 0;

  const count = (sel) => chrome.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const click = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
  const attr = (sel, a) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`);
  const texts = (sel) => chrome.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
  const gotoRetry = async (url) => { try { await chrome.goto(url); } catch { await chrome.goto(url); } };
  const open = async (pid) => {
    await gotoRetry(base + '/vertly_mark.svg?' + Date.now());
    await gotoRetry(base + `/studio/#/p/${pid}`);
    await chrome.waitFor(`!!document.querySelector('[data-testid=biz-partner]')`, 25000);
  };
  const panelState = () => attr('[data-testid=biz-partner]', 'data-state');
  const dbProject = async (pid = PID) => (await jfetch(`${SB}/rest/v1/projects?id=eq.${pid}&select=stage,files,published_files,published_version,updated_at,published_at`, { headers: svc })).json?.[0];
  const stateVersions = async () => ((await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state&select=version&order=version.desc`, { headers: svc })).json ?? []).map((x) => x.version);
  const waitState = (s, ms = 30000) => chrome.waitFor(`document.querySelector('[data-testid=biz-partner]')?.dataset.state === ${JSON.stringify(s)}`, ms);
  const LEAK = /anthropic|credit balance|billing|api key|sk-ant|claude/i;

  // ── 1. too little data: the panel says so and does not offer to ask ───────────────────────────────────────────────
  await open(PID_EARLY);
  check('a site with a few visitors: the partner is "waiting", honest about it', (await panelState()) === 'waiting' && /too early/i.test((await text('[data-testid=partner-wait]')) ?? ''), await text('[data-testid=partner-wait]'));
  check('…and there is nothing to press (no way to spend credits on a non-answer)', (await count('[data-testid=partner-ask]')) === 0 && (await count('[data-testid=partner-advice]')) === 0);
  await chrome.screenshot(`${OUT}/partner-waiting.png`);

  // ── 2. enough data: an explicit button, nothing runs by itself ───────────────────────────────────────────────────
  await open(PID);
  check('a site with real numbers: the partner waits to be asked', (await panelState()) === 'idle' && (await count('[data-testid=partner-ask]')) === 1 && (await count('[data-testid=partner-advice]')) === 0, await panelState());
  check('…it says it uses credits and reads only this page', /credits/i.test((await text('[data-testid=biz-partner]')) ?? '') && /numbers on this page/i.test((await text('[data-testid=biz-partner]')) ?? ''));
  const asked0 = ((await rest(`rate_limits?key=eq.${encodeURIComponent('partner:' + uid)}&select=key`)).json ?? []).length;
  check('opening the screen asked nothing: no rate-limit hit, no usage', asked0 === 0, asked0);
  await chrome.screenshot(`${OUT}/partner-idle.png`);

  if (!MOCK) {
    // ── 3. no model behind it (the Anthropic account has no credit): a polite, plain failure that reveals nothing ────
    await click('[data-testid=partner-ask]');
    await chrome.waitFor(`!!document.querySelector('[data-testid=partner-error]') || !!document.querySelector('[data-testid=partner-advice]')`, 40000);
    const err = (await text('[data-testid=partner-error]')) ?? '';
    if (err) {
      check('the ask failed politely: "not available right now"', /not available right now|busy right now/i.test(err), err);
      check('…and says nothing about the provider, credit balance, billing or keys', !LEAK.test(err), err);
      check('…the button is back so they can try later', (await count('[data-testid=partner-ask]')) === 1 && (await panelState()) === 'idle');
    } else {
      check('a model answered: advice is shown (the Anthropic account has credit now)', (await count('[data-testid=partner-rec]')) >= 1);
      for (const t of await texts('[data-testid=partner-rec]')) info('REAL ADVICE: ' + t.replace(/\s+/g, ' ').slice(0, 400));
    }
    await chrome.screenshot(`${OUT}/partner-real.png`);
  } else {
    // ── 3. ask ──────────────────────────────────────────────────────────────────────────────────────────────────────
    await click('[data-testid=partner-ask]');
    check('asking shows progress while it looks', !!(await chrome.waitFor(`document.querySelector('[data-testid=biz-partner]')?.dataset.state === 'asking' || !!document.querySelector('[data-testid=partner-advice]')`, 15000)));
    check('advice arrives', !!(await waitState('advice')), await panelState());
    const recs = await chrome.eval(`[...document.querySelectorAll('[data-testid=partner-rec]')].map((e) => ({ id: e.dataset.id, title: e.querySelector('h4')?.textContent, evidence: [...e.querySelectorAll('[data-testid=partner-evidence]')].map((x) => x.textContent), apply: !!e.querySelector('[data-testid=partner-apply]') }))`);
    check('two recommendations, each with a title and the numbers behind it', recs.length === 2 && recs.every((x) => x.title && x.evidence.length >= 1), JSON.stringify(recs));
    check('the evidence is the owner’s own figures (60 visitors, 3 orders)', recs[0].evidence.some((e) => /Visitors: 60/.test(e)) && recs[0].evidence.some((e) => /Orders: 3/.test(e)), JSON.stringify(recs[0].evidence));
    check('only the site change has an Apply button; the "share more" step has none', recs.find((x) => x.id === 'stand-out')?.apply === true && recs.find((x) => x.id === 'share-more')?.apply === false, JSON.stringify(recs.map((x) => [x.id, x.apply])));
    check('a note says which numbers it was based on, and that Apply only changes the draft', /Based on your numbers for the last 30 days/.test((await text('[data-testid=partner-basis]')) ?? '') && /draft/i.test((await text('[data-testid=partner-basis]')) ?? ''), await text('[data-testid=partner-basis]'));
    check('the screen’s own copy of the numbers still matches (the note has no "ask again" warning)', !/ask again/i.test((await text('[data-testid=partner-basis]')) ?? ''), await text('[data-testid=partner-basis]'));
    const asked1 = ((await rest(`rate_limits?key=eq.${encodeURIComponent('partner:' + uid)}&select=key`)).json ?? []).length;
    check('exactly one ask was counted against the hourly limit', asked1 === 1, asked1);
    await chrome.viewport(1280, 1500);
    await sleep(300);
    await chrome.screenshot(`${OUT}/partner-advice.png`);
    await chrome.viewport(1280, 1100);

    // ── 4. survives leaving and coming back ────────────────────────────────────────────────────────────────────────
    await chrome.eval(`1`);
    await open(PID);
    check('after a page reload the advice is still there and nothing was asked again', (await panelState()) === 'advice' && (await count('[data-testid=partner-ask]')) === 0 && (await count('[data-testid=partner-rec]')) === 2, await panelState());
    check('…with an "Ask again" button', (await count('[data-testid=partner-ask-again]')) === 1);

    // ── 5. Apply → TWEAKS runs the change by itself ────────────────────────────────────────────────────────────────
    check('nothing has changed since the site went live, so no "changes not live yet" note', (await count('[data-testid=biz-changed]')) === 0);
    await sleep(Math.max(0, 33000 - (Date.now() - lastWrite)));
    const before = await dbProject();
    await click('[data-testid=partner-rec][data-id=stand-out] [data-testid=partner-apply]');
    check('Apply opens TWEAKS', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=tweaks-stage]')`, 20000)) && (await dbProject())?.stage === 'tweaks');
    check('…the suggestion is sent as the owner’s own message, with nothing pointed at', !!(await chrome.waitFor(`document.querySelector('[data-testid=chat-line][data-role=user]')?.textContent.includes('stand out')`, 30000)), await texts('[data-testid=chat-line]'));
    const done = await chrome.waitFor(`!document.querySelector('[data-testid=tweaks-working]') && !document.querySelector('[data-testid=chat-live]') && document.querySelectorAll('[data-testid=chat-line]').length >= 2`, 90000).catch(() => null);
    check('…and the change is made without anyone typing', !!done, JSON.stringify(await texts('[data-testid=chat-line]')));
    const after = await dbProject();
    check('the draft has the new accent colour', /--accent:\s*#b45309/i.test(after?.files?.['styles.css'] ?? '') && !/--accent:\s*#b45309/i.test(before?.files?.['styles.css'] ?? ''));
    check('the LIVE site did not move: same published copy, same version', JSON.stringify(after?.published_files) === JSON.stringify(LIVE) && after?.published_version === 1);
    check('it can be undone (a version was saved)', (await chrome.eval(`!document.querySelector('[data-testid=tweaks-undo]')?.disabled`)) === true);
    check('the suggestion is not sent twice (one owner line in the chat)', (await count('[data-testid=chat-line][data-role=user]')) === 1, await count('[data-testid=chat-line][data-role=user]'));
    await chrome.screenshot(`${OUT}/partner-applied-tweaks.png`);

    // ── 6. back to BUSINESS: the advice is there, marked, and the live site is waiting to be updated ───────────────
    await click('button[data-stage=business]');
    check('back on BUSINESS', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=business-stage]')`, 20000)));
    await chrome.waitFor(`!!document.querySelector('[data-testid=biz-partner]')`, 15000);
    check('the same advice is still shown (no new ask), and the applied one is marked', (await count('[data-testid=partner-rec]')) === 2 && (await attr('[data-testid=partner-rec][data-id=stand-out]', 'data-applied')) === 'true' && /Sent to Edit site/.test((await text('[data-testid=partner-applied]')) ?? ''), await attr('[data-testid=partner-rec][data-id=stand-out]', 'data-applied'));
    check('the screen says there are changes visitors cannot see yet — and offers Update live site', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=biz-changed]')`, 15000)) && (await count('[data-testid=biz-update]')) === 1);
    await chrome.screenshot(`${OUT}/partner-back.png`);

    // ── 7. numbers left too long: it refreshes them by itself and still answers ────────────────────────────────────
    const v0 = (await stateVersions())[0];
    const stale = (await rest(`project_artifacts?project_id=eq.${PID}&kind=eq.business_state&version=eq.${v0}&select=data`, { headers: { Prefer: 'return=representation' } })).json?.[0]?.data;
    await put(PID, 'business_state', { ...stale, computed_at: new Date(Date.now() - 3 * 3600e3).toISOString() });
    await click('[data-testid=partner-ask-again]');
    check('the saved numbers were 3 hours old: it refreshed them and answered, with no error shown', !!(await chrome.waitFor(`document.querySelector('[data-testid=biz-partner]')?.dataset.state === 'advice' && !document.querySelector('[data-testid=partner-error]') && document.querySelector('[data-testid=partner-ask-again]')`, 40000)) && (await count('[data-testid=partner-error]')) === 0);
    const vs = await stateVersions();
    check('…by saving fresh numbers (a newer business_state version, from now)', vs[0] > v0 + 1, JSON.stringify(vs.slice(0, 3)));
    check('…and a new answer replaces the old marks (nothing applied yet)', (await attr('[data-testid=partner-rec][data-id=stand-out]', 'data-applied')) === 'false');

    // ── 8. a model that is down: plain words, nothing about credit or the provider ───────────────────────────────────
    await patch(`projects?id=eq.${PID}`, { name: 'Wick & Co mock-credit' });
    await click('[data-testid=partner-ask-again]');
    check('the partner being unavailable shows a polite message', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=partner-error]')`, 40000)) && /not available right now/i.test((await text('[data-testid=partner-error]')) ?? ''), await text('[data-testid=partner-error]'));
    check('…and reveals nothing about credit, billing or the provider', !LEAK.test((await text('[data-testid=biz-partner]')) ?? ''), await text('[data-testid=partner-error]'));
    check('…the earlier advice stays on screen', (await count('[data-testid=partner-rec]')) === 2);
    await chrome.screenshot(`${OUT}/partner-error.png`);
    await patch(`projects?id=eq.${PID}`, { name: NAME });
  }

  // ── a phone ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await open(PID);
  await chrome.viewport(390, 900, true);
  await sleep(500);
  const mo = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5 && !e.closest('svg')).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('no horizontal overflow at 390 px', mo.sw <= 390 && mo.wide.length === 0, JSON.stringify(mo));
  await chrome.screenshot(`${OUT}/partner-mobile.png`);
  await chrome.viewport(1280, 1100);

  const errs = chrome.consoleMsgs.filter((m) => m.type === 'exception' || (m.type === 'error' && !/favicon|Failed to load resource/i.test(m.text)));
  check('no uncaught exceptions / console errors', errs.length === 0, JSON.stringify(errs).slice(0, 400));
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  try { if (chrome) await chrome.close(); } catch { /* ignore */ }
  try { if (local) local.server.close(); } catch { /* ignore */ }
  for (const pid of [PID, PID_EARLY]) await jfetch(`${SB}/rest/v1/projects?id=eq.${pid}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/rest/v1/projects?user_id=eq.${uid}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/rest/v1/rate_limits?key=eq.${encodeURIComponent('partner:' + uid)}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  info('cleanup: throwaway user + projects deleted');
  console.log(`\n${pass} passed, ${fail} failed`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
}

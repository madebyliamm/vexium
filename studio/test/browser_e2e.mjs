#!/usr/bin/env node
// Step 6 "Done when" evidence (extended in Steps 7–8 with the stage engine and the guided PLAN screen): the assembled site in a real (headless) Chrome — signed-out bounce to /auth.html and back,
// signed-in studio rendering with the shared tokens, routing, sign-out, legacy pages still served, repo/docs NOT served.
//
//   (cd studio && npm run build) && node scripts/assemble-site.mjs      # produce _site/
//   node studio/test/browser_e2e.mjs                                    # serves _site/ on localhost and tests that
//   E2E_BASE=https://vexium.ai node studio/test/browser_e2e.mjs         # tests the deployed site instead
//   E2E_AI=1 node studio/test/browser_e2e.mjs                           # also sends one real PLAN message (spends model credits)
//
// Needs: Google Chrome, the `supabase` CLI logged in (to read the service key), network. Creates a throwaway user + one
// project and deletes both in `finally`. Screenshots: /tmp/studio-e2e/. Use dangerouslyDisableSandbox with the Bash tool.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { launch } from '../../sdk/test/cdp.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const OUT = '/tmp/studio-e2e';
mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-studio-e2e)' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 300)}]` : '')); };
const info = (m) => console.log('INFO ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── static server that behaves like GitHub Pages for the assembled _site/ ─────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveSite(dir) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = normalize(join(dir, p));
    if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; res.setHeader('Content-Type', 'text/html'); return res.end('404'); }
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

const rand = Math.random().toString(36).slice(2, 8);
const username = `vxstudio${rand}`;
const email = `${username}@vexium.ai`;
const password = 'Studio-e2e-' + rand + '!9';
const PID = 'e2e-studio-' + rand;
const PROJECT_NAME = 'Studio E2E ' + rand;

let uid = null, chrome = null, local = null;
try {
  // ── setup: throwaway user + project ───────────────────────────────────────────────────────────────────
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  uid = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  const SESSION = r.json; // {access_token, refresh_token, expires_at, expires_in, token_type, user}
  r = await jfetch(SB + '/rest/v1/projects', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, user_id: uid, name: PROJECT_NAME, emoji: '🧪', files: {}, main_file: 'index.html' }) });
  if (r.status >= 300) throw new Error('create project failed: ' + r.text);

  let base = process.env.E2E_BASE;
  if (!base) {
    const dir = join(REPO, '_site');
    if (!existsSync(join(dir, 'studio/index.html'))) throw new Error('_site/ not found — run the build + node scripts/assemble-site.mjs first');
    local = await serveSite(dir);
    base = local.base;
  }
  info('testing ' + base);
  const live = !!process.env.E2E_BASE;
  const STORAGE_KEY = `sb-${REF}-auth-token`;

  // ── what is (not) served ──────────────────────────────────────────────────────────────────────────────
  for (const p of ['/index.html', '/auth.html', '/home.html', '/editor.html', '/viewer.html', '/config.js', '/vertly_mark.svg', '/sdk/v1.js', '/studio/']) {
    const res = await fetch(base + p, { headers: UA });
    check(`served: ${p}`, res.status === 200, res.status);
  }
  for (const p of ['/REVAMP.md', '/docs/SECURITY_FINDINGS.md', '/supabase/schema.sql', '/supabase/functions/ai-chat/index.ts', '/publisher/wrangler.toml', '/studio/package.json', '/studio/src/main.tsx']) {
    const res = await fetch(base + p, { headers: UA });
    check(`NOT served: ${p}`, res.status === 404, res.status);
  }

  chrome = await launch();
  if (!chrome) throw new Error('Chrome not found (set CHROME_BIN)');
  await chrome.viewport(1280, 800);

  // ── 1. signed out → bounced to auth.html with ?next= ──────────────────────────────────────────────────
  await chrome.goto(base + '/vertly_mark.svg'); // any page on the origin, to clear storage there
  await chrome.eval('localStorage.clear(); sessionStorage.clear(); true');
  await chrome.goto(base + '/studio/#/p/abc');
  const bounced = await chrome.waitFor(`location.pathname === '/auth.html'`, 10000);
  check('signed out: studio redirects to /auth.html', bounced, await chrome.eval('location.href'));
  const nextParam = await chrome.eval(`new URLSearchParams(location.search).get('next')`);
  check('signed out: ?next= carries the studio URL including the hash route', nextParam === '/studio/#/p/abc', nextParam);

  // ── 2. signed in → studio renders ─────────────────────────────────────────────────────────────────────
  await chrome.goto(base + '/vertly_mark.svg');
  await chrome.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(SESSION))}); true`);
  chrome.consoleMsgs.length = 0;
  await chrome.goto(base + '/studio/');
  check('signed in: topbar renders', await chrome.waitFor(`!!document.querySelector('.topbar')`, 10000));
  check('signed in: stays on /studio/ (no bounce)', (await chrome.eval('location.pathname')) === '/studio/');
  check('avatar shows the username initial', (await chrome.eval(`document.querySelector('.avatar')?.textContent`)) === username[0].toUpperCase(), await chrome.eval(`document.querySelector('.avatar')?.textContent`));
  check('project grid lists the throwaway project', await chrome.waitFor(`document.querySelector('[data-testid=project-grid]')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 10000));
  await chrome.screenshot(`${OUT}/home.png`);

  // shared tokens actually drive the page
  const tokens = await chrome.eval(`(() => { const cs = getComputedStyle(document.documentElement); return { accent: cs.getPropertyValue('--accent').trim(), bg: cs.getPropertyValue('--bg').trim(), body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.card')).backgroundColor, btn: getComputedStyle(document.querySelector('.btn')).borderRadius }; })()`);
  check('tokens.css loaded: --accent #7c3aed, --bg #f1f1f4', tokens.accent === '#7c3aed' && tokens.bg === '#f1f1f4', JSON.stringify(tokens));
  check('body background is --bg (light theme), cards are white', tokens.body === 'rgb(241, 241, 244)' && tokens.card === 'rgb(255, 255, 255)', `${tokens.body} / ${tokens.card}`);
  // re-theme: change ONE token and the page follows (proves components use the variables, not copies of the colors)
  const retheme = await chrome.eval(`(() => { document.documentElement.style.setProperty('--s1', 'rgb(1, 2, 3)'); const c = getComputedStyle(document.querySelector('.card')).backgroundColor; document.documentElement.style.removeProperty('--s1'); return c; })()`);
  check('changing --s1 re-colours the cards', retheme === 'rgb(1, 2, 3)', retheme);
  check('no horizontal overflow at 1280px', await chrome.eval(`document.documentElement.scrollWidth <= innerWidth`));

  // ── 3. routing ────────────────────────────────────────────────────────────────────────────────────────
  await chrome.eval(`document.querySelector('[data-testid=project-grid] a').click(); true`);
  check('clicking a card routes to #/p/<id>', await chrome.waitFor(`location.hash === '#/p/${PID}'`, 5000), await chrome.eval('location.hash'));
  check('project page shows name + 6 stages', await chrome.waitFor(`document.querySelector('h1')?.textContent.includes(${JSON.stringify(PROJECT_NAME)}) && document.querySelectorAll('.stage').length === 6`, 8000));
  check('"Open in editor" links to the legacy editor', (await chrome.eval(`[...document.querySelectorAll('a')].find(a => a.textContent.includes('Open in editor'))?.getAttribute('href')`)) === `/editor.html?project=${PID}`);
  await chrome.screenshot(`${OUT}/project.png`);


  // ── 3b. the stage engine in the real UI (Step 7) ──────────────────────────────────────────────────────
  const rpcSvc = (name, body) => jfetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const dbStage = async () => (await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}&select=stage`, { headers: svc })).json?.[0]?.stage;
  const stepState = (stage) => chrome.eval(`document.querySelector('.stage[data-stage=${stage}]')?.dataset.state`);
  const reloadProject = async () => { await chrome.eval(`location.reload(); true`); await chrome.waitFor(`!!document.querySelector('[data-testid=stage-panel]')`, 15000); };
  const click = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
  const text = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const PLAN = { schema: 1, name: PROJECT_NAME, kind: 'site', one_liner: 'x', audience: 'y', offer: 'z', pricing: { model: 'none', items: [] }, pages: [{ file: 'index.html', title: 'Home', purpose: 'p' }], backend: { collections: [], products: [], forms: [], auth: false }, launch_checklist: [], scenario: null };
  const STYLE = { schema: 1, locked: true, vibe: { theme: 'light', density: 'comfortable', tone: 'warm' }, tokens: { '--accent': '#7c3aed' }, fonts: { display: 'Fraunces', body: 'Inter' } };
  const put = (kind, data) => rpcSvc('put_project_artifact', { p_project: PID, p_kind: kind, p_data: data });

  await chrome.waitFor(`!!document.querySelector('[data-testid=stage-panel]')`, 10000);
  check('new project starts at PLAN: panel shows Plan, stepper marks it current', (await chrome.eval(`document.querySelector('[data-testid=stage-panel]').dataset.stage`)) === 'plan' && (await stepState('plan')) === 'current');
  check('every later stage is blocked (nothing saved yet)', (await Promise.all(['example', 'build', 'tweaks', 'launch', 'business'].map(stepState))).every((x) => x === 'blocked'));
  check('"Continue" is disabled and says why', (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true && (await text('[data-testid=stage-why]')).includes('Needs your plan first'), await text('[data-testid=stage-why]'));
  await click('.stage[data-stage=build]');
  check('clicking a blocked stage explains what is missing and does not move', await chrome.waitFor(`document.querySelector('[data-testid=stage-notice]')?.textContent.includes('Needs your plan first')`, 3000) && (await dbStage()) === 'plan', await text('[data-testid=stage-notice]'));
  await chrome.screenshot(`${OUT}/stage-plan-empty.png`);

  // ── 3c. the guided PLAN screen (Step 8): chat on the left, an editable plan card on the right ──────────
  // Typing goes through the native value setter + an input event, which is what a keystroke does to a Preact input.
  const setValue = async (sel, value, nth = 0) => {
    await chrome.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
    await sleep(60); // let the page re-render before the next click reads its handlers
  };
  const count = (sel) => chrome.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const planRow = async () => (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.plan&select=version,data`, { headers: svc })).json?.[0];
  const planStatus = (want) => chrome.waitFor(`document.querySelector('[data-testid=plan-status]')?.textContent === ${JSON.stringify(want)}`, 8000);

  check('PLAN screen: the chat (with its greeting) sits beside the plan card', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=plan-stage] [data-testid=chat-greeting]') && !!document.querySelector('[data-testid=plan-card]')`, 8000)));
  check('PLAN screen: no plan yet → "Not started" with a way to fill it in yourself', (await text('[data-testid=plan-status]')) === 'Not started' && (await count('[data-testid=plan-blank]')) === 1, await text('[data-testid=plan-status]'));
  check('PLAN screen replaces the artifact list and the "on its way" note', (await count('.artifact')) === 0 && !(await text('[data-testid=stage-panel]')).includes('on its way'));
  await click('[data-testid=plan-blank]');
  check('"Fill it in myself" opens an unsaved card with a Home page, named after the project', await planStatus('Unsaved changes') && (await count('[data-testid=page-row]')) === 1 && (await chrome.eval(`document.querySelector('[data-testid=plan-name]').value`)) === PROJECT_NAME, await text('[data-testid=plan-status]'));
  await setValue('[data-testid=plan-oneliner]', 'A test site');
  await click('[data-testid=plan-save]');
  check('Save plan → "Saved · v1" on screen and version 1 in the database', await planStatus('Saved · v1') && (await planRow())?.version === 1 && (await planRow())?.data?.one_liner === 'A test site', JSON.stringify(await planRow()).slice(0, 200));

  await click('[data-testid=page-add]');
  await click('[data-testid=plan-save]');
  check('a page with no title or file name is refused in plain words, and nothing is sent', await chrome.waitFor(`document.querySelector('[data-testid=plan-save-error]')?.textContent.includes('Page 2 needs a title')`, 4000) && (await planRow())?.version === 1, await text('[data-testid=plan-save-error]'));
  await setValue('[data-testid=page-title]', 'About', 1);
  await setValue('[data-testid=page-file]', 'about.html', 1);
  check('editing clears the message', (await count('[data-testid=plan-save-error]')) === 0);
  await click('[data-testid=plan-save]');
  check('after filling the page in, Save → v2 with both pages', await planStatus('Saved · v2') && (await planRow())?.version === 2 && (await planRow())?.data?.pages?.length === 2, JSON.stringify((await planRow())?.data?.pages));

  check('the what-if needs a price first (button disabled)', (await chrome.eval(`document.querySelector('[data-testid=scenario-start]').disabled`)) === true);
  await setValue('[data-testid=pricing-model]', 'subscription');
  await click('[data-testid=price-add]');
  await setValue('[data-testid=price-name]', 'Monthly');
  await setValue('[data-testid=price-amount]', '12.50');
  await setValue('[data-testid=checklist-new]', 'Photos of the dogs');
  await click('[data-testid=checklist-add]');
  check('a price and a checklist item are added to the card', (await count('[data-testid=price-row]')) === 1 && (await count('[data-testid=checklist-row]')) === 1);
  await click('[data-testid=scenario-start]');
  check('"Try a revenue what-if" shows a calculator using that price', await chrome.waitFor(`document.querySelector('[data-testid=scenario-result]')?.textContent.includes('12.50')`, 3000), await text('[data-testid=scenario-result]'));
  await setValue('[data-testid=scenario-visitors]', '1000');
  await setValue('[data-testid=scenario-conversion]', '2');
  check('the calculator does the sum (1,000 × 2% × 12.50 = 250.00 a month)', /= 250(\.00)? a month/.test(await text('[data-testid=scenario-result]')), await text('[data-testid=scenario-result]'));
  await click('[data-testid=plan-save]');
  const v3 = await planStatus('Saved · v3') && (await planRow());
  check('Save → v3 keeps price, checklist and the owner-chosen what-if', v3?.version === 3 && v3.data.pricing.model === 'subscription' && v3.data.pricing.items[0]?.price_cents === 1250 && v3.data.launch_checklist?.[0]?.label === 'Photos of the dogs' && v3.data.scenario?.monthly_visitors === 1000 && v3.data.scenario?.conversion_pct === 2, JSON.stringify(v3?.data).slice(0, 300));
  check('the earlier "Needs your plan first" notice went away once a plan was saved', (await count('[data-testid=stage-notice]')) === 0);
  check('v1 and v2 are still stored (every save is a new version)', (await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.plan&select=version`, { headers: svc })).json?.length === 3);
  await chrome.screenshot(`${OUT}/stage-plan-card.png`);

  await chrome.viewport(390, 800, true);
  await sleep(300);
  const pw = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('PLAN screen has no horizontal overflow at 390px', pw.sw <= 390 && pw.wide.length === 0, JSON.stringify(pw));
  await chrome.screenshot(`${OUT}/stage-plan-mobile.png`);
  await chrome.viewport(1280, 800);
  await sleep(200);

  // unsaved edits keep "Continue" closed; discarding opens it again
  await setValue('[data-testid=plan-name]', PROJECT_NAME + ' (draft)');
  check('unsaved edits: status says so and "Continue" is held with a reason', (await text('[data-testid=plan-status]')) === 'Unsaved changes' && (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true && (await text('[data-testid=stage-hold]'))?.includes('Save your plan changes first'), await text('[data-testid=stage-hold]'));
  await click('[data-testid=plan-discard]');
  check('"Discard changes" restores the saved plan and re-opens "Continue"', await planStatus('Saved · v3') && (await chrome.eval(`document.querySelector('[data-testid=plan-name]').value`)) === PROJECT_NAME && (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === false);

  // the conversation is stored on the server: it comes back after a reload; only the platform can write it
  const at = (n) => new Date(Date.now() - (10 - n) * 1000).toISOString();
  const seeded = await jfetch(`${SB}/rest/v1/stage_messages`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify([
    { project_id: PID, stage: 'plan', role: 'user', content: 'A site for my dog-walking business', user_id: uid, created_at: at(1) },
    { project_id: PID, stage: 'plan', role: 'assistant', content: "Here's a first plan. Who are your customers?", user_id: null, created_at: at(2) },
    { project_id: PID, stage: 'plan', role: 'user', content: 'Busy people in Austin', user_id: uid, created_at: at(3) },
  ]) });
  const forged = await jfetch(`${SB}/rest/v1/stage_messages`, { method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + SESSION.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: PID, stage: 'plan', role: 'assistant', content: 'forged', user_id: uid }) });
  check('chat history: the owner cannot write stage_messages directly (only the platform does)', seeded.status < 300 && forged.status >= 400, `seed ${seeded.status} / owner insert ${forged.status}`);
  await reloadProject();
  check('after a reload the chat is back, oldest first, without the greeting', await chrome.waitFor(`document.querySelectorAll('[data-testid=chat-line]').length === 3`, 8000)
    && (await chrome.eval(`[...document.querySelectorAll('[data-testid=chat-line]')].map((l) => l.dataset.role).join()`)) === 'user,assistant,user' && (await count('[data-testid=chat-greeting]')) === 0);
  check('…an unanswered last message offers "Try again"', (await count('[data-testid=chat-retry]')) === 1);
  check('…and the saved plan is back too', (await text('[data-testid=plan-status]')) === 'Saved · v3' && (await chrome.eval(`document.querySelector('[data-testid=plan-name]').value`)) === PROJECT_NAME);
  await chrome.screenshot(`${OUT}/stage-plan-chat.png`);

  check('after a plan is saved, EXAMPLE opens (state "open")', (await stepState('example')) === 'open', await stepState('example'));
  await click('[data-testid=stage-continue]');
  check('Continue moves to EXAMPLE (UI + database agree)', await chrome.waitFor(`document.querySelector('.stage[data-stage=example]')?.dataset.state === 'current'`, 8000) && (await dbStage()) === 'example', await dbStage());
  check('earlier stage is marked "past"', (await stepState('plan')) === 'past');
  check('EXAMPLE panel lists the plan (from an earlier step) and the style (not made yet)', (await text('.artifact[data-kind=style_spec]')).includes('Not made yet') && (await text('.artifact[data-kind=plan]')).includes('from an earlier step'));
  check('Continue is blocked on the style', (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true && (await text('[data-testid=stage-why]')).includes('Needs your style first'), await text('[data-testid=stage-why]'));
  await chrome.screenshot(`${OUT}/stage-example.png`);

  await put('style_spec', { ...STYLE, locked: false });
  await reloadProject();
  check('an UNLOCKED style still blocks the full build ("Lock your style first")', (await text('[data-testid=stage-why]')).includes('Lock your style first'), await text('[data-testid=stage-why]'));
  await put('style_spec', STYLE);
  await put('manifest', { schema: 1, built_at: '2026-10-14T10:00:00Z', pages: [{ file: 'index.html', title: 'Home' }], shared_files: ['styles.css'], backend: { collections: [], products: [], forms: [], auth: false } });
  await put('launch_checks', { schema: 1, checked_at: '2026-10-14T10:05:00Z', manifest_version: 1, ok: true, open_items: [], checks: [] });
  await reloadProject();
  check('with a locked style, manifest and verifier result, LAUNCH opens straight from EXAMPLE', (await stepState('launch')) === 'open', await stepState('launch'));
  await click('.stage[data-stage=launch]');
  check('clicking an open stage moves there', await chrome.waitFor(`document.querySelector('.stage[data-stage=launch]')?.dataset.state === 'current'`, 8000) && (await dbStage()) === 'launch', await dbStage());
  await click('[data-testid=stage-back]');
  check('Back goes to TWEAKS', await chrome.waitFor(`document.querySelector('.stage[data-stage=tweaks]')?.dataset.state === 'current'`, 8000) && (await dbStage()) === 'tweaks', await dbStage());
  check('BUSINESS stays blocked until something is published', (await stepState('business')) === 'blocked');
  await chrome.screenshot(`${OUT}/stage-tweaks.png`);

  // editing the plan makes everything built from it stale — flagged in the stepper, the cards, and the way forward
  await put('plan', { ...PLAN, name: PROJECT_NAME + ' (edited)' });
  await reloadProject();
  check('after a plan edit the stepper flags the stages whose result is out of date', (await chrome.eval(`[...document.querySelectorAll('.stage.attention')].map(e => e.dataset.stage).sort().join()`)) === 'build,example,tweaks', await chrome.eval(`[...document.querySelectorAll('.stage.attention')].map(e => e.dataset.stage).join()`));
  check('the TWEAKS panel shows the built site as "Out of date" with a "Keep as is" button', (await text('.artifact[data-kind=manifest]')).includes('Out of date') && (await text('.artifact[data-kind=manifest]')).includes('Keep as is'), await text('.artifact[data-kind=manifest]'));
  check('LAUNCH is blocked again ("out of date")', (await stepState('launch')) === 'blocked' && (await text('[data-testid=stage-why]')).includes('out of date'), await text('[data-testid=stage-why]'));
  check('the current stage was NOT yanked away from the user', (await dbStage()) === 'tweaks');
  await chrome.screenshot(`${OUT}/stage-stale.png`);
  await chrome.eval(`document.querySelector('.artifact[data-kind=style_spec] button').click(); true`);
  check('"Keep as is" on the style clears its flag in the UI and the database', await chrome.waitFor(`!document.querySelector('.artifact[data-kind=style_spec]')?.textContent.includes('Out of date')`, 8000)
    && (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.style_spec&select=stale`, { headers: svc })).json?.[0]?.stale === false);

  // a stage run in progress (started before this page load) — shown, stoppable; a dead one is not shown as live
  const nowIso = () => new Date().toISOString();
  let jr = await jfetch(`${SB}/rest/v1/build_jobs`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ project_id: PID, user_id: uid, status: 'running', prompt: 'e2e run', stage: 'plan', artifact_kind: 'plan', heartbeat_at: nowIso() }) });
  const liveJobId = jr.json?.[0]?.id;
  await reloadProject();
  check('a running stage job (fresh heartbeat) shows "Still working…" with a Stop button', await chrome.waitFor(`!!document.querySelector('[data-testid=job-running]') && !!document.querySelector('[data-testid=job-stop]')`, 8000), `insert ${jr.status} ${jr.text.slice(0, 160)} | page: ${(await chrome.eval(`document.querySelector('main')?.innerText.slice(0, 200)`))}`);
  await chrome.screenshot(`${OUT}/stage-running.png`);
  await click('[data-testid=job-stop]');
  check('Stop calls ai-chat; the job is closed as "Stopped" and the banner goes away', await chrome.waitFor(`!document.querySelector('[data-testid=job-running]')`, 10000)
    && (await jfetch(`${SB}/rest/v1/build_jobs?id=eq.${liveJobId}&select=status,error`, { headers: svc })).json?.[0]?.error === 'Stopped');
  check('…and the failed run is mentioned once', await chrome.waitFor(`document.querySelector('[data-testid=job-failed]')?.textContent.includes('Stopped')`, 8000), await text('[data-testid=job-failed]'));
  await jfetch(`${SB}/rest/v1/build_jobs?id=eq.${liveJobId}`, { method: 'DELETE', headers: svc });
  await jfetch(`${SB}/rest/v1/build_jobs`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ project_id: PID, user_id: uid, status: 'running', prompt: 'dead run', stage: 'plan', artifact_kind: 'plan', created_at: new Date(Date.now() - 600000).toISOString(), heartbeat_at: new Date(Date.now() - 120000).toISOString() }) });
  await reloadProject();
  check('a "running" job whose Worker went silent (no heartbeat for 2 min) is NOT shown as live', !(await chrome.eval(`!!document.querySelector('[data-testid=job-running]')`)));
  await jfetch(`${SB}/rest/v1/build_jobs?project_id=eq.${PID}`, { method: 'DELETE', headers: svc });

  // a stranger's view of the same URL
  await chrome.viewport(390, 800, true);
  await reloadProject();
  const pm = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('project page has no horizontal overflow at 390px', pm.sw <= 390 && pm.wide.length === 0, JSON.stringify(pm));
  await chrome.screenshot(`${OUT}/stage-mobile.png`);
  await chrome.viewport(1280, 800);

  // ── 3d. starting from an idea on the home screen (Step 8) ─────────────────────────────────────────────
  // The build Worker call is stubbed to fail, so the default run spends nothing on a model; E2E_AI=1 sends it for real below.
  const IDEA = 'A site for my dog-walking business in Austin';
  await chrome.eval(`location.hash = '#/'; true`);
  check('Home: "Start something new" box sits above the projects', await chrome.waitFor(`!!document.querySelector('[data-testid=new-project]')`, 8000));
  check('"Draft my plan" stays disabled until something is typed', (await chrome.eval(`document.querySelector('[data-testid=idea-go]').disabled`)) === true);
  await chrome.eval(`window.__realFetch = window.fetch; window.fetch = (input, init) => { const u = typeof input === 'string' ? input : input.url; return u.startsWith('https://vexium-ai-build.startafter.workers.dev') ? Promise.resolve(new Response(JSON.stringify({ error: 'e2e: build Worker stubbed' }), { status: 503, headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(input, init); }; true`);
  await setValue('[data-testid=idea-input]', IDEA);
  await click('[data-testid=idea-go]');
  check('"Draft my plan" creates a project and opens it', await chrome.waitFor(`/^#\\/p\\/proj_/.test(location.hash)`, 10000), await chrome.eval('location.hash'));
  const newId = (await chrome.eval('location.hash')).replace('#/p/', '');
  const created = (await jfetch(`${SB}/rest/v1/projects?id=eq.${newId}&select=user_id,stage,name`, { headers: svc })).json?.[0];
  check('…the new project belongs to the user, is called Untitled and starts at PLAN', created?.user_id === uid && created.stage === 'plan' && created.name === 'Untitled', JSON.stringify(created));
  check('…the idea went out as the first message; refused, it is back in the box with the reason shown', await chrome.waitFor(`!!document.querySelector('[data-testid=chat-error]') && document.querySelector('[data-testid=chat-input]').value === ${JSON.stringify(IDEA)}`, 10000), await text('[data-testid=chat-error]'));
  check('…and nothing was saved: still "Not started", and the message can be sent again', (await text('[data-testid=plan-status]')) === 'Not started' && (await chrome.eval(`document.querySelector('[data-testid=chat-send]').disabled`)) === false);
  await chrome.screenshot(`${OUT}/plan-new-project.png`);

  if (process.env.E2E_AI) {
    // The real thing (spends model credits): a vague idea → a reply and a first saved plan, all through the Worker.
    // keep a copy of what the Worker streams, so a failed run can say why (the UI only shows a friendly sentence)
    await chrome.eval(`window.__workerText = ''; window.fetch = async (input, init) => { const res = await window.__realFetch(input, init); const u = typeof input === 'string' ? input : input.url; if (u.startsWith('https://vexium-ai-build.startafter.workers.dev')) res.clone().text().then((t) => { window.__workerText += t; }, () => {}); return res; }; true`);
    await click('[data-testid=chat-send]');
    const replied = await chrome.waitFor(`document.querySelector('[data-testid=plan-status]')?.textContent.startsWith('Saved') && document.querySelectorAll('[data-testid=chat-line][data-role=assistant]').length >= 1`, 180000);
    check('AI: the first message gets a reply and a saved plan', replied, (await text('[data-testid=plan-status]')) + ' | ' + (await text('[data-testid=chat-error]')));
    if (!replied) info('AI worker stream: ' + JSON.stringify((await chrome.eval('window.__workerText')).slice(0, 800)));
    if (!replied) info('AI job: ' + JSON.stringify((await jfetch(`${SB}/rest/v1/build_jobs?project_id=eq.${newId}&select=status,error,stage&order=created_at.desc&limit=1`, { headers: svc })).json));
    const aiPlan = (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${newId}&kind=eq.plan&select=version,data`, { headers: svc })).json?.[0];
    const reply = await chrome.eval(`[...document.querySelectorAll('[data-testid=chat-line][data-role=assistant]')].map((l) => l.textContent).join(' // ')`);
    info('AI plan: ' + JSON.stringify(aiPlan?.data ?? null).slice(0, 1500));
    info('AI reply: ' + reply);
    check('AI: the plan is about the idea and has pages; the reply is short and has no markers', !!aiPlan && aiPlan.data.pages.length >= 1 && !reply.includes('[[') && reply.length < 1200, JSON.stringify(aiPlan?.data?.name ?? null));
    check('AI: no revenue what-if the owner did not ask for', aiPlan?.data?.scenario === null, JSON.stringify(aiPlan?.data?.scenario ?? null));
    check('AI: the project took the plan\'s name', await chrome.waitFor(`!/Untitled/.test(document.querySelector('h1')?.textContent ?? 'Untitled')`, 10000), await text('h1'));
    await chrome.screenshot(`${OUT}/plan-ai.png`);
  }

  await chrome.eval(`if (window.__realFetch) window.fetch = window.__realFetch; location.hash = '#/p/does-not-exist'; true`);
  check('unknown project id → "Project not found"', await chrome.waitFor(`document.body.textContent.includes('Project not found')`, 8000));
  await chrome.eval(`location.hash = '#/nope/nope'; true`);
  check('unknown route → "Page not found"', await chrome.waitFor(`document.body.textContent.includes('Page not found')`, 5000));

  await chrome.eval(`location.hash = '#/system'; true`);
  check('/system: connectivity checks finish', await chrome.waitFor(`document.querySelectorAll('[data-testid=checks] .check .dot.ok, [data-testid=checks] .check .dot.bad').length === 4`, 20000));
  const dots = await chrome.eval(`[...document.querySelectorAll('[data-testid=checks] .check')].map(c => (c.querySelector('.dot.ok') ? 'ok ' : 'BAD ') + c.textContent).join(' | ')`);
  check('/system: all 4 backend checks are green (CORS from this origin + session accepted by ai-chat)', !/BAD/.test(dots), dots);
  check('/system: shows account + plan', (await chrome.eval(`document.querySelector('[data-testid=account]')?.textContent`)).includes(username), await chrome.eval(`document.querySelector('[data-testid=account]')?.textContent`));
  await chrome.screenshot(`${OUT}/system.png`);

  // ── 4. mobile ─────────────────────────────────────────────────────────────────────────────────────────
  await chrome.viewport(390, 800, true);
  await chrome.eval(`location.hash = '#/'; true`);
  await chrome.waitFor(`!!document.querySelector('[data-testid=project-grid]')`, 8000);
  const m = await chrome.eval(`(() => { const w = innerWidth; const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).slice(0, 5); return { iw: w, sw: document.documentElement.scrollWidth, wide }; })()`);
  check('no horizontal overflow at 390px (nothing extends past the 390px screen)', m.sw <= 390 && m.wide.length === 0, JSON.stringify(m));
  await chrome.screenshot(`${OUT}/home-mobile.png`);
  await chrome.viewport(1280, 800);

  const errs = chrome.consoleMsgs.filter((m) => m.type === 'exception' || (m.type === 'error' && !/favicon|Failed to load resource/i.test(m.text)));
  check('no uncaught exceptions / console errors while using the studio', errs.length === 0, JSON.stringify(errs).slice(0, 400));

  // ── 5. auth.html returns people to the studio (and refuses anything else) ─────────────────────────────
  await chrome.goto(base + '/auth.html?next=' + encodeURIComponent('/studio/#/system'));
  check('signed in + auth.html?next=/studio/#/system → goes to the studio', await chrome.waitFor(`location.pathname === '/studio/' && location.hash === '#/system'`, 10000), await chrome.eval('location.href'));
  await chrome.goto(base + '/auth.html?next=' + encodeURIComponent('//evil.example/studio/'));
  check('signed in + hostile ?next= → home.html (no open redirect)', await chrome.waitFor(`location.pathname === '/home.html'`, 10000), await chrome.eval('location.href'));

  // ── 6. legacy page still works from the assembled site ────────────────────────────────────────────────
  chrome.consoleMsgs.length = 0;
  await chrome.goto(base + '/home.html');
  check('legacy home.html renders the dashboard with the project', await chrome.waitFor(`document.body.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 15000));
  const legacyErrs = chrome.consoleMsgs.filter((m) => m.type === 'exception');
  check('legacy home.html: no uncaught exceptions', legacyErrs.length === 0, JSON.stringify(legacyErrs).slice(0, 300));
  await chrome.screenshot(`${OUT}/legacy-home.png`);

  // ── 7. sign out ───────────────────────────────────────────────────────────────────────────────────────
  await chrome.goto(base + '/studio/');
  await chrome.waitFor(`!!document.querySelector('.topbar')`, 10000);
  await chrome.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Sign out')).click(); true`);
  check('Sign out → landing page', await chrome.waitFor(`location.pathname === '/index.html' || location.pathname === '/'`, 10000), await chrome.eval('location.href'));
  check('Sign out clears the stored session', (await chrome.eval(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`)) === null);
  await chrome.goto(base + '/studio/');
  check('after sign-out the studio bounces to /auth.html again', await chrome.waitFor(`location.pathname === '/auth.html'`, 10000));

  // ── 8. the full loop through the REAL sign-in form (username → auth-gate → session) and back to the studio ─────
  await chrome.eval(`switchTab('signin'); true`);
  await chrome.eval(`document.getElementById('signinUser').value = ${JSON.stringify(username)}; document.getElementById('signinPass').value = ${JSON.stringify(password)}; document.getElementById('btnSignin').click(); true`);
  check('signing in on auth.html (by username) returns to the studio URL the guard remembered', await chrome.waitFor(`location.pathname === '/studio/'`, 20000), await chrome.eval('location.href'));
  check('…and the studio shows the signed-in user', await chrome.waitFor(`!!document.querySelector('.avatar')`, 10000));
  void live;
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  try { if (chrome) await chrome.close(); } catch { /* ignore */ }
  try { if (local) local.server.close(); } catch { /* ignore */ }
  await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/rest/v1/projects?user_id=eq.${uid}`, { method: 'DELETE', headers: svc }); // projects the test made through the UI
  if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  info('cleanup: throwaway user + project deleted');
  console.log(`\n${pass} passed, ${fail} failed`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
}

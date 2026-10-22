#!/usr/bin/env node
// Step 6 "Done when" evidence (extended in Steps 7–9 with the stage engine, the guided PLAN screen and the EXAMPLE screen): the assembled site in a real (headless) Chrome — signed-out bounce to /auth.html and back,
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
  check('"Discard changes" restores the saved plan and re-opens "Continue"', await planStatus('Saved · v3') && (await chrome.eval(`document.querySelector('[data-testid=plan-name]').value`)) === PROJECT_NAME && !!(await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]')?.disabled === false`, 8000))); // Continue follows the parent's state a render later — wait, don't read once

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
  check('EXAMPLE shows the guided screen (page area + controls), not the artifact list', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=example-stage]')`, 8000)) && (await count('.artifact')) === 0);
  check('Continue is blocked on the style', (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true && (await text('[data-testid=stage-why]')).includes('Needs your style first'), await text('[data-testid=stage-why]'));
  await chrome.screenshot(`${OUT}/stage-example.png`);

  // ── 3e. the EXAMPLE screen (Step 9): the landing page, five vibe controls that re-skin it, "Lock this style" ──
  // The page is a sandboxed iframe (no allow-same-origin) = its own process: the driver attaches to that target to look inside.
  const inFrame = async (expr) => { const f = await chrome.frame('about:srcdoc'); if (!f) return undefined; try { return await f.eval(expr); } finally { await f.detach(); } };
  const waitFrame = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await inFrame(expr); if (v) return v; } catch { /* still loading */ } await sleep(150); } return false; };
  const cssVar = (name) => inFrame(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  const bodyBg = () => inFrame(`getComputedStyle(document.body).backgroundColor`);
  const styleRow = async () => (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.style_spec&select=version,data,stale`, { headers: svc })).json?.[0];
  const dbFiles = async () => (await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}&select=files`, { headers: svc })).json?.[0]?.files ?? {};
  const exStatus = () => chrome.eval(`document.querySelector('[data-testid=example-stage]')?.dataset.status`);
  const exStatusIs = (want) => chrome.waitFor(`document.querySelector('[data-testid=example-stage]')?.dataset.status === ${JSON.stringify(want)}`, 8000);
  const dark = (rgb) => { const n = (rgb.match(/\d+/g) ?? []).map(Number); return n.length >= 3 && n[0] + n[1] + n[2] < 300; };
  const continueHeld = () => chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`);

  // a — nothing built yet
  check('EXAMPLE, nothing built: a "Build my landing page" button and an optional direction box', (await count('[data-testid=example-empty]')) === 1 && (await chrome.eval(`document.querySelector('[data-testid=example-build]').disabled`)) === false && (await count('[data-testid=example-note-input]')) === 1);
  check('…status says "Not built yet" and the controls say they appear once the page exists', (await text('[data-testid=example-status]')) === 'Not built yet' && (await count('[data-testid=vibe-waiting]')) === 1 && (await count('[data-testid=vibe-controls]')) === 0);

  // b — a build that streams three files and then the connection drops (the Worker call is stubbed; no model is used)
  const SEED_CSS_RAW = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;600&display=swap');
:root {
  --bg: #f6f1e9;  --surface: #ffffff;  --surface-2: #efe8dc;  --border: #e2d8c8;
  --text: #1f1a17;  --text-muted: #6b6258;
  --accent: #b4532a;  --accent-contrast: #ffffff;
  --font-display: 'Fraunces', Georgia, serif;  --font-body: 'Inter', system-ui, sans-serif;
  --radius: 12px;  --radius-lg: 20px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.06);  --shadow-lg: 0 20px 50px -12px rgba(0,0,0,.2);
  --container: 1200px;  --nav-h: 68px;  --section-y: clamp(80px, 12vw, 160px)
}
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-body); line-height: 1.6 }
h1, h2 { font-family: var(--font-display); line-height: 1.15 }
section { max-width: var(--container); margin: 0 auto; padding: var(--section-y) 24px }
.btn { display: inline-block; background: var(--accent); color: var(--accent-contrast); padding: 12px 22px; border-radius: var(--radius); text-decoration: none }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow-sm) }
`;
  const SEED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Bean There</title><link rel="stylesheet" href="styles.css"/></head>
<body>
<header data-vx-nav></header>
<main>
<section id="hero"><h1>Bean There</h1><p>Small-batch coffee, roasted in Austin.</p><a class="btn" href="#visit">Find us</a> <a data-e2e="menu-link" href="menu.html">See the menu</a></section>
<section id="about"><h2>Our story</h2><p>We roast every Tuesday and sell out by Friday.</p></section>
<section id="beans"><h2>The beans</h2><div class="card"><p>Three origins, roasted light.</p></div></section>
<section id="visit"><h2>Visit</h2><p>12 Congress Ave, Austin.</p></section>
</main>
<footer data-vx-footer></footer>
<script src="site.js"></script>
</body></html>`;
  const SEED_JS = `window.SITE = { name: "Bean There", nav: [ { label: "Home", href: "index.html" }, { label: "Menu", href: "menu.html" }, { label: "Visit", href: "index.html#visit" } ], cta: { label: "Order", href: "#visit" }, footer: { tagline: "Coffee, slowly.", columns: [], social: [], legal: "© {year} Bean There" } };`;
  const SEED_MANIFEST = JSON.stringify({ name: 'Bean There', short_name: 'Bean There', start_url: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000' }, null, 2);
  const stub = (files) => `(() => { const enc = new TextEncoder(); const files = ${JSON.stringify(files)}; window.__realFetch2 = window.fetch;
    window.fetch = (input, init) => { const u = typeof input === 'string' ? input : input.url; if (!u.startsWith('https://vexium-ai-build.startafter.workers.dev')) return window.__realFetch2(input, init);
      window.__runBody = JSON.parse(init.body); let ctl; const send = (ev, d) => ctl.enqueue(enc.encode('event: ' + ev + '\\ndata: ' + JSON.stringify(d) + '\\n\\n'));
      const body = new ReadableStream({ start(c) { ctl = c; send('stage_job', { job_id: 'e2e-job', stage: 'example' }); send('start', {}); send('delta', { text: 'Setting up the colours.' });
        for (const [name, content] of Object.entries(files)) send('file', { name, content }); window.__release = () => ctl.close(); } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })); }; return true; })()`;
  await chrome.eval(stub({ 'styles.css': SEED_CSS_RAW, 'index.html': SEED_HTML, 'site.js': SEED_JS }));
  await setValue('[data-testid=example-note-input]', 'calm, lots of white space');
  await click('[data-testid=example-build]');
  check('Build: the live checklist shows 3 of 4 steps done while the last file is still coming', await chrome.waitFor(`[...document.querySelectorAll('[data-testid=example-progress] li')].map((l) => l.dataset.state).join() === 'done,done,done,active'`, 8000), await chrome.eval(`[...document.querySelectorAll('[data-testid=example-progress] li')].map((l) => l.dataset.state).join()`));
  check('…the owner\'s direction went out as the message, for the EXAMPLE stage', (await chrome.eval(`window.__runBody?.stage + '|' + window.__runBody?.project_id + '|' + window.__runBody?.messages?.[0]?.content`)) === `example|${PID}|calm, lots of white space`, await chrome.eval(`JSON.stringify(window.__runBody)`));
  check('…the chat line streams in, and Stop is offered', (await text('[data-testid=example-live-chat]')) === 'Setting up the colours.' && (await count('[data-testid=example-stop]')) === 1 && (await exStatus()) === 'building');
  check('…the page already shows in the preview while it builds (sandboxed: allow-scripts only)', (await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`)) === true && (await chrome.eval(`document.querySelector('[data-testid=preview-frame]').getAttribute('sandbox')`)) === 'allow-scripts');
  check('…the menu and footer are drawn by the Vertly SDK inside the preview', (await waitFrame(`document.querySelectorAll('.vx-nav .vx-link').length >= 3 && !!document.querySelector('.vx-footer')`, 15000)) === true, await inFrame(`document.body.innerHTML.slice(0, 200)`));
  check('…the controls stay shut while it builds, and Continue is held', (await count('[data-testid=vibe-controls]')) === 0 && (await continueHeld()) === true);
  await chrome.screenshot(`${OUT}/example-building.png`);
  await chrome.eval(`window.__release(); true`);
  check('Build, connection cut before the end: says so in plain words and returns to the empty state', await chrome.waitFor(`document.querySelector('[data-testid=example-run-error]')?.textContent.includes('interrupted') && !!document.querySelector('[data-testid=example-empty]')`, 10000), await text('[data-testid=example-run-error]'));
  check('…nothing was saved by that run (no style, still the starter page)', (await styleRow()) === undefined && !(await dbFiles())['styles.css']);
  await chrome.eval(`window.fetch = window.__realFetch2; true`);

  // c — the page exists (as the finisher stores it); the owner sees it
  const { applyStyleSpec, deriveStyleSpec, manifestWithStyle } = await import('../../supabase/functions/_shared/style.ts');
  const seedSpec = deriveStyleSpec(SEED_CSS_RAW, { tone: 'warm and friendly', voice: 'Warm and plain.' }).spec;
  const asOwner = { apikey: ANON, Authorization: 'Bearer ' + SESSION.access_token, 'Content-Type': 'application/json' };
  const seedFiles = await jfetch(`${SB}/rest/v1/rpc/set_project_files`, { method: 'POST', headers: asOwner, body: JSON.stringify({ p_project: PID, p_files: { 'index.html': SEED_HTML, 'styles.css': applyStyleSpec(SEED_CSS_RAW, seedSpec), 'site.js': SEED_JS, 'manifest.json': manifestWithStyle(SEED_MANIFEST, seedSpec), 'menu.html': '<!DOCTYPE html><html><body><h1>Menu</h1></body></html>' } }) });
  const seedStyle = await put('style_spec', { ...seedSpec, locked: false });
  await jfetch(`${SB}/rest/v1/stage_messages`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify([{ project_id: PID, stage: 'example', role: 'assistant', content: 'I made a warm, editorial page for Bean There.', user_id: null }]) });
  check('seed: the owner can write project files through set_project_files; the style is stored', seedFiles.status < 300 && seedStyle.status < 300, `${seedFiles.status} ${seedFiles.text.slice(0, 120)} / ${seedStyle.status} ${seedStyle.text.slice(0, 120)}`);
  await reloadProject();
  check('the built page is shown with the controls beside it; status "Not locked yet"', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=vibe-controls]')`, 10000)) && (await exStatus()) === 'unlocked' && (await text('[data-testid=example-status]')) === 'Not locked yet', await exStatus());
  check('the AI\'s note about the page is shown', await chrome.waitFor(`document.querySelector('[data-testid=example-said]')?.textContent === 'I made a warm, editorial page for Bean There.'`, 8000), await text('[data-testid=example-said]'));
  check('the preview renders the page with the stored colours', (await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`)) === true && (await bodyBg()) === 'rgb(246, 241, 233)' && (await cssVar('--accent')) === '#b4532a', `${await bodyBg()} ${await cssVar('--accent')}`);
  check('the sandbox holds: the page can reach neither the studio window nor the studio\'s storage', (await inFrame(`(() => { let a = 'blocked', b = 'blocked'; try { parent.document.title; a = 'reached'; } catch (e) {} try { localStorage.length; b = 'reached'; } catch (e) {} return a + '/' + b; })()`)) === 'blocked/blocked', await inFrame(`1`));
  check('Continue is blocked ("Lock your style first")', (await continueHeld()) === true && (await text('[data-testid=stage-why]')).includes('Lock your style first'), await text('[data-testid=stage-why]'));
  await chrome.screenshot(`${OUT}/example-built.png`);

  // d — the five controls re-skin the page in place: no reload, no AI, within a second or so
  await inFrame(`window.__alive = 'yes'; true`);
  const styleBefore = await styleRow();
  let t0 = Date.now();
  await click('[data-testid=vibe-theme-dark]');
  const wentDark = await waitFrame(`(() => { const n = (getComputedStyle(document.body).backgroundColor.match(/\\d+/g) || []).map(Number); return n[0] + n[1] + n[2] < 300; })()`, 4000);
  const darkMs = Date.now() - t0;
  check('Theme → Dark re-skins the open page (and does it fast)', wentDark === true && darkMs < 2500, `${darkMs}ms, bg ${await bodyBg()}`);
  check('…without reloading it (a marker set inside the page survives)', (await inFrame(`window.__alive`)) === 'yes');
  check('…status "Unsaved changes", Continue stays closed ("Lock your style first"), Save / Discard appear', (await exStatus()) === 'unsaved' && (await continueHeld()) === true && (await text('[data-testid=stage-why]'))?.includes('Lock your style first') && (await count('[data-testid=style-save]')) === 1 && (await count('[data-testid=style-discard]')) === 1, `${await exStatus()} / ${await text('[data-testid=stage-why]')}`);
  check('…nothing is written until Save (same style version, same stylesheet in the database)', (await styleRow()).version === styleBefore.version && (await dbFiles())['styles.css'].includes('#f6f1e9'));
  await click('[data-testid=vibe-accent-teal]');
  check('Colour → teal changes the accent inside the page', !!(await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#0f766e'`, 4000)) && (await inFrame(`getComputedStyle(document.querySelector('.btn')).backgroundColor`)) === 'rgb(15, 118, 110)', await cssVar('--accent'));
  const sectionBefore = await cssVar('--section-y');
  await click('[data-testid=vibe-density-airy]');
  check('Spacing → Airy changes the section spacing', !!(await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--section-y').trim() !== ${JSON.stringify(sectionBefore)}`, 4000)), `${sectionBefore} → ${await cssVar('--section-y')}`);
  const radiusBefore = await cssVar('--radius');
  await click('[data-testid=vibe-tone-bold]');
  check('Tone → Bold changes the corner rounding', !!(await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim() !== ${JSON.stringify(radiusBefore)}`, 4000)), `${radiusBefore} → ${await cssVar('--radius')}`);
  await click('[data-testid=vibe-pairing-technical]');
  check('Fonts → Technical swaps both typefaces and loads the new ones', !!(await waitFrame(`/Space Grotesk/.test(getComputedStyle(document.documentElement).getPropertyValue('--font-display')) && /Space(\\+| )Grotesk/.test(document.getElementById('vx-style').textContent)`, 4000)), await cssVar('--font-display'));
  check('…the page markup is untouched through all of that (same marker, same h1)', (await inFrame(`window.__alive + '|' + document.querySelector('h1').textContent`)) === 'yes|Bean There');
  check('…each active choice is marked in the controls', (await chrome.eval(`['vibe-theme-dark', 'vibe-accent-teal', 'vibe-density-airy', 'vibe-tone-bold', 'vibe-pairing-technical'].every((t) => document.querySelector('[data-testid=' + t + ']').getAttribute('aria-pressed') === 'true')`)) === true);
  await chrome.screenshot(`${OUT}/example-restyled.png`);
  await setValue('[data-testid=vibe-accent-custom]', '#1a1410');
  check('A custom colour is accepted, and one that is faint on this dark page is flagged in plain words (not forbidden)', !!(await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#1a1410'`, 4000)) && (await count('[data-testid=vibe-hints]')) === 1, await text('[data-testid=vibe-hints]'));
  await click('[data-testid=vibe-accent-teal]');

  // e — Save writes the style and the files as one new version; other pages are left alone
  await click('[data-testid=style-save]');
  check('Save: status goes back to "Not locked yet" and Continue is no longer held for unsaved changes', await exStatusIs('unlocked') && !(await text('[data-testid=stage-hold]'))?.includes('Save or discard'), await exStatus());
  const afterSave = await styleRow(); const filesAfterSave = await dbFiles();
  check('…a new style version (one more than before) holds the new look, still unlocked', afterSave.version === styleBefore.version + 1 && afterSave.data.locked === false && afterSave.data.tokens['--accent'].toLowerCase() === '#0f766e' && afterSave.data.vibe.theme === 'dark', JSON.stringify(afterSave).slice(0, 300));
  check('…styles.css and manifest.json in the project follow (tokens, font import, theme colour)', /--accent:\s*#0f766e/i.test(filesAfterSave['styles.css']) && /Space(\+| )Grotesk/.test(filesAfterSave['styles.css']) && JSON.parse(filesAfterSave['manifest.json']).theme_color === '#0f766e' && JSON.parse(filesAfterSave['manifest.json']).background_color !== '#000000', JSON.parse(filesAfterSave['manifest.json'] ?? '{}').theme_color);
  check('…the page and the other pages were not touched', filesAfterSave['index.html'] === SEED_HTML && filesAfterSave['menu.html'].includes('<h1>Menu</h1>') && filesAfterSave['site.js'] === SEED_JS);

  // f — Lock freezes it
  await click('[data-testid=style-lock]');
  check('Lock this style: status "Style locked", the box says so', await exStatusIs('locked') && (await text('[data-testid=example-status]')) === 'Style locked' && (await chrome.eval(`document.querySelector('[data-testid=lock-box]').dataset.locked`)) === 'true');
  const locked1 = await styleRow();
  check('…stored: locked true as the next version, same look', locked1.data.locked === true && locked1.version === afterSave.version + 1 && locked1.data.tokens['--accent'].toLowerCase() === '#0f766e', JSON.stringify(locked1).slice(0, 200));
  check('…the controls are shut (all five groups disabled) and say why', (await chrome.eval(`document.querySelectorAll('[data-testid=vibe-controls] fieldset:disabled').length`)) === 5 && (await text('[data-testid=vibe-closed]'))?.includes('locked'), await text('[data-testid=vibe-closed]'));
  check('…"Continue" opens (the full build may start in this look)', await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]').disabled === false`, 8000));
  check('…asking the AI for a new page is closed too until unlocked', (await chrome.eval(`document.querySelector('[data-testid=example-redo]').disabled`)) === true && (await text('[data-testid=example-redo]')).includes('Unlock first'));
  await chrome.screenshot(`${OUT}/example-locked.png`);
  await reloadProject();
  check('after a reload: still locked, page back in the saved look (dark, teal)', !!(await chrome.waitFor(`document.querySelector('[data-testid=example-stage]')?.dataset.status === 'locked'`, 10000)) && !!(await waitFrame(`document.querySelector('h1')`)) && dark(await bodyBg()) && (await cssVar('--accent')).toLowerCase() === '#0f766e', `${await bodyBg()} ${await cssVar('--accent')}`);

  // g — Unlock, then change-and-lock in one step; Discard
  await click('[data-testid=style-unlock]');
  check('Unlock to change it: unlocked again as a new version, controls open', await exStatusIs('unlocked') && (await styleRow()).data.locked === false && (await styleRow()).version === locked1.version + 1 && (await chrome.eval(`document.querySelectorAll('[data-testid=vibe-controls] fieldset:disabled').length`)) === 0);
  await click('[data-testid=vibe-theme-light]');
  check('a changed, unlocked style offers "Save and lock this style"', (await text('[data-testid=style-lock]')) === 'Save and lock this style');
  const vBeforeLock = (await styleRow()).version;
  await click('[data-testid=style-lock]');
  check('"Save and lock" is ONE new version: light theme AND locked', await exStatusIs('locked') && (await styleRow()).version === vBeforeLock + 1 && (await styleRow()).data.locked === true && (await styleRow()).data.vibe.theme === 'light', JSON.stringify((await styleRow()).data.vibe));
  check('…and the stylesheet in the project is light again', /--bg:\s*#[0-9a-f]{6}/i.test((await dbFiles())['styles.css']) && !dark(await bodyBg()), await bodyBg());
  await click('[data-testid=style-unlock]');
  await exStatusIs('unlocked');
  const accentSaved = (await cssVar('--accent')).toLowerCase();
  await click('[data-testid=vibe-accent-red]');
  await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() !== ${JSON.stringify(accentSaved)}`, 4000);
  await click('[data-testid=style-discard]');
  check('Discard: the page returns to the saved look and the status to "Not locked yet"', await exStatusIs('unlocked') && !!(await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === ${JSON.stringify(accentSaved)}`, 4000)) && (await count('[data-testid=style-save]')) === 0);

  // h — the preview itself: phone width, links to other pages, errors inside the page
  await click('[data-testid=preview-phone]');
  const frameW = () => chrome.eval(`Math.round(document.querySelector('[data-testid=preview-frame]').getBoundingClientRect().width)`); // the width eases over 0.2s
  check('Phone view narrows the preview to a phone width', await chrome.waitFor(`Math.round(document.querySelector('[data-testid=preview-frame]').getBoundingClientRect().width) === 390`, 3000), await frameW());
  await click('[data-testid=preview-desktop]');
  check('Desktop view widens it again', await chrome.waitFor(`document.querySelector('[data-testid=preview-frame]').getBoundingClientRect().width > 500`, 3000), await frameW());
  await inFrame(`document.querySelector('[data-e2e=menu-link]').click(); true`);
  check('clicking a link to another page says that page is built in the next step (the preview does not navigate)', await chrome.waitFor(`document.querySelector('[data-testid=preview-other-page]')?.textContent.includes('menu.html')`, 4000) && (await inFrame(`document.querySelector('h1').textContent`)) === 'Bean There', await text('[data-testid=preview-other-page]'));
  await inFrame(`setTimeout(() => { throw new Error('boom from the page'); }, 0); true`);
  check('an error thrown by the page\'s own code is reported under the preview', await chrome.waitFor(`document.querySelector('[data-testid=preview-problem]')?.textContent.includes('boom from the page')`, 4000), await text('[data-testid=preview-problem]'));

  // i — small screens
  await chrome.viewport(390, 800, true);
  await reloadProject();
  await chrome.waitFor(`!!document.querySelector('[data-testid=vibe-controls]')`, 10000);
  await waitFrame(`document.querySelector('h1')`);
  const pe = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, frame: Math.round(document.querySelector('[data-testid=preview-frame]').getBoundingClientRect().width), wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('EXAMPLE screen has no horizontal overflow at 390px (controls stack under the page)', pe.sw <= 390 && pe.wide.length === 0, JSON.stringify(pe));
  await chrome.screenshot(`${OUT}/example-mobile.png`);
  await chrome.viewport(1280, 800);

  // j — on to the full build and back
  await chrome.viewport(1280, 800);
  await reloadProject();
  await chrome.waitFor(`!!document.querySelector('[data-testid=style-lock]')`, 10000);
  await click('[data-testid=style-lock]');
  await exStatusIs('locked');
  await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]').disabled === false`, 8000);
  await click('[data-testid=stage-continue]');
  check('Continue from a locked style moves on to BUILD', await chrome.waitFor(`document.querySelector('.stage[data-stage=build]')?.dataset.state === 'current'`, 8000) && (await dbStage()) === 'build', await dbStage());
  // ── 3f. the FULL BUILD screen (Step 10): start → live checklist → Stop → build again → launch report + the whole site, page by page ──
  // The Worker call is stubbed (no model, no Workflow). The test plays the Worker's part: it writes the job, the checklist rows and the
  // finished site with the service key — the same rows ai-chat writes in production. E2E_AI=1 below runs the real thing.
  const iso = () => new Date().toISOString();
  const bsIs = (want, ms = 8000) => chrome.waitFor(`document.querySelector('[data-testid=build-stage]')?.dataset.status === ${JSON.stringify(want)}`, ms);
  const bsStatus = () => chrome.eval(`document.querySelector('[data-testid=build-stage]')?.dataset.status`);
  const sbWrite = (method, path, body, prefer = 'return=minimal') => jfetch(`${SB}/rest/v1/${path}`, { method, headers: { ...svc, 'Content-Type': 'application/json', Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const newBuildJob = async () => {
    const j = (await sbWrite('POST', 'build_jobs', { project_id: PID, user_id: uid, status: 'running', prompt: 'e2e build', stage: 'build', artifact_kind: 'manifest', heartbeat_at: iso() }, 'return=representation')).json?.[0]?.id;
    const beat = setInterval(() => { void sbWrite('PATCH', `build_jobs?id=eq.${j}&status=eq.running`, { heartbeat_at: iso() }); }, 5000); // the Worker stamps a heartbeat every few seconds
    return { id: j, stopBeat: () => clearInterval(beat) };
  };
  const addSteps = (job, rows) => sbWrite('POST', 'build_steps', rows.map(([seq, kind, file, label, status, extra]) => ({ job_id: job, project_id: PID, seq, kind, file, label, status, ...(extra ?? {}) })));
  const setStep = (job, seq, patch) => sbWrite('PATCH', `build_steps?job_id=eq.${job}&seq=eq.${seq}`, patch);
  const stubBuildStart = (jobId) => chrome.eval(`(() => { window.__realFetch3 = window.__realFetch3 || window.fetch; window.__buildBody = null;
    window.fetch = (input, init) => { const u = typeof input === 'string' ? input : input.url; if (!u.startsWith('https://vexium-ai-build.startafter.workers.dev')) return window.__realFetch3(input, init);
      window.__buildBody = JSON.parse(init.body); return Promise.resolve(new Response(JSON.stringify({ ok: true, job_id: ${JSON.stringify(jobId)}, stage: 'build' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }; return true; })()`);
  const CHECKLIST = [[0, 'prepare', null, 'Setting up the shared files', 'done'], [1, 'page', 'index.html', 'Home page', 'done'], [2, 'page', 'about.html', 'About page', 'running'], [100, 'verify', null, 'Checking links, forms and checkout', 'pending'], [101, 'save', null, 'Saving your site', 'pending']];

  check('BUILD: the guided screen replaces the artifact list — "Ready to build", a direction box and one button', await bsIs('ready') && (await count('[data-testid=build-start]')) === 1 && (await count('[data-testid=build-note-input]')) === 1 && (await count('.artifact')) === 0 && (await text('[data-testid=build-status]')) === 'Ready to build', await bsStatus());
  check('BUILD: nothing in the way (plan, fresh locked style) → no blocker message', (await count('[data-testid=build-blocker]')) === 0);
  await chrome.screenshot(`${OUT}/build-ready.png`);

  // run 1 — start, watch it go, Stop
  const run1 = await newBuildJob();
  await addSteps(run1.id, CHECKLIST);
  await stubBuildStart(run1.id);
  await setValue('[data-testid=build-note-input]', 'keep the copy short');
  await click('[data-testid=build-start]');
  check('BUILD: "Build my full site" asks the Worker for a build of this project with the owner\'s direction', !!(await chrome.waitFor(`!!window.__buildBody`, 5000)) && await chrome.eval(`window.__buildBody.stage === 'build' && window.__buildBody.project_id === ${JSON.stringify(PID)} && window.__buildBody.messages[0].content === 'keep the copy short' && window.__buildBody.stream === true`), JSON.stringify(await chrome.eval('window.__buildBody')));
  check('BUILD: the screen switches to the live checklist', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=build-running]') && document.querySelectorAll('[data-testid=build-progress] li').length === 5`, 10000)), await bsStatus());
  const ls = () => chrome.eval(`[...document.querySelectorAll('[data-testid=build-progress] li')].map((l) => l.dataset.state).join()`);
  check('BUILD: checklist order is setup, pages, check, save — with each step\'s state', (await ls()) === 'done,done,active,todo,todo' && (await chrome.eval(`document.querySelector('[data-testid=build-progress]').textContent`)).includes('About page'), await ls());
  check('BUILD: the headline says how many pages are done; the bar shows 2 of 5 steps', (await text('[data-testid=build-headline]')).includes('1 of 2 done') && (await chrome.eval(`document.querySelector('[data-testid=build-bar]').getAttribute('aria-valuenow')`)) === '40', await text('[data-testid=build-headline]'));
  check('BUILD: while it runs there is a Stop button, the project banner, and "Continue" is closed', (await count('[data-testid=build-stop]')) === 1 && (await count('[data-testid=job-running]')) === 1 && (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true);
  await chrome.screenshot(`${OUT}/build-running.png`);
  await setStep(run1.id, 2, { status: 'done', cost_cents: 3.5 });
  await setStep(run1.id, 100, { status: 'running', detail: 'Looking at 2 pages' });
  check('BUILD: the checklist follows the database within a few seconds (pages done → "Checking links…")', !!(await chrome.waitFor(`document.querySelector('[data-testid=build-headline]')?.textContent.includes('Checking links, forms and checkout')`, 9000)) && (await ls()) === 'done,done,done,active,todo', await ls());
  check('BUILD: the cost so far is shown as it builds', (await text('[data-testid=build-cost]')).includes('$0.04'), await text('[data-testid=build-cost]'));
  await click('[data-testid=build-stop]');
  check('BUILD: Stop closes the run; the screen says it did not finish, that nothing was saved, and offers the button again', !!(await bsIs('failed', 12000)) && (await count('[data-testid=build-start]')) === 1 && (await count('[data-testid=build-running]')) === 0 && (await text('[data-testid=build-failed]'))?.includes('Nothing was saved'), await bsStatus());
  check('BUILD: …the job is closed as "Stopped" in the database and no site was written', (await jfetch(`${SB}/rest/v1/build_jobs?id=eq.${run1.id}&select=status,error`, { headers: svc })).json?.[0]?.error === 'Stopped' && !(await dbFiles())['about.html']);
  run1.stopBeat();

  // run 2 — start again; the Worker finishes the site
  const run2 = await newBuildJob();
  await addSteps(run2.id, CHECKLIST);
  await stubBuildStart(run2.id);
  await click('[data-testid=build-start]');
  check('BUILD: starting again (no direction) sends the default message', !!(await chrome.waitFor(`!!window.__buildBody`, 5000)) && (await chrome.eval(`window.__buildBody.messages[0].content`)) === 'Build my site');
  check('BUILD: …and the checklist is back', !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=build-progress] li').length === 5`, 10000)));
  await chrome.eval(`window.fetch = window.__realFetch3; true`); // later steps talk to the real backend

  const ABOUT_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>About</title><link rel="stylesheet" href="styles.css"/></head><body><header data-vx-nav></header><main><section><h1>About us</h1><p>Two friends and a roaster.</p><a data-e2e="home-link" href="index.html">Back home</a></section></main><footer data-vx-footer></footer><script src="site.js"></script></body></html>`;
  const HOME_HTML = SEED_HTML.replace('menu.html', 'about.html').replace('See the menu', 'About us').replace('<a data-e2e="menu-link"', '<a data-e2e="about-link"')
    .replace('</main>', '<p><a data-e2e="gone-link" href="gone.html">Old page</a></p></main>');
  await sbWrite('PATCH', `projects?id=eq.${PID}`, { files: { ...(await dbFiles()), 'index.html': HOME_HTML, 'about.html': ABOUT_HTML } });
  const mput = await put('manifest', { schema: 1, built_at: iso(), pages: [{ file: 'index.html', title: 'Home', in_nav: true }, { file: 'about.html', title: 'About', in_nav: true }], shared_files: ['styles.css', 'site.js'], backend: { collections: [], products: [], forms: ['contact'], auth: false }, cost_cents: 43 });
  const mver = mput.json?.version;
  const lput = await put('launch_checks', { schema: 1, checked_at: iso(), manifest_version: mver, ok: false, open_items: ['Add your real opening hours'], checks: [
    { id: 'links', label: 'Every link goes somewhere', status: 'fail', detail: 'index.html links to gone.html, which is not a page of this site.', page: 'index.html' },
    { id: 'alt', label: 'Images have descriptions', status: 'warn', detail: 'One image has no description.' },
    { id: 'forms', label: 'The contact form is connected', status: 'pass' },
  ] });
  check('BUILD (setup): the finished site, manifest and report were saved as the platform would', mput.status < 300 && lput.status < 300 && Number.isInteger(mver), `${mput.status} ${mput.text.slice(0, 120)} / ${lput.status} ${lput.text.slice(0, 120)}`);
  await sbWrite('PATCH', `build_jobs?id=eq.${run2.id}`, { status: 'complete', finished_at: iso() });
  run2.stopBeat();
  check('BUILD: when the run ends the screen shows the built site ("Built"), no longer the checklist', !!(await bsIs('built', 15000)) && (await count('[data-testid=build-running]')) === 0, (await bsStatus()) + ' | ' + (await chrome.eval(`document.body.innerText.slice(0, 80).replace(/\\s+/g, ' ')`)) + ' | ' + JSON.stringify(chrome.consoleMsgs.filter((m) => m.type === 'exception' || m.type === 'error').slice(-3)));
  check('BUILD: the summary names the pages, the form and the cost of the build', (await text('[data-testid=build-summary]')) === '2 pages · 1 form · Build cost $0.43', await text('[data-testid=build-summary]'));
  check('BUILD: the launch report says what failed (with the page), what is worth a look and what is left to do', (await text('[data-testid=build-report]')).includes('1 problem to fix, 1 thing worth a look') && (await text('[data-testid=report-fails]')).includes('gone.html') && (await text('[data-testid=report-warns]')).includes('no description') && (await text('[data-testid=report-open]')).includes('opening hours') && (await chrome.eval(`document.querySelector('[data-testid=build-report]').dataset.ok`)) === 'false', await text('[data-testid=build-report]'));
  check('BUILD: passed checks are tucked away until asked for', (await count('[data-testid=report-passes]')) === 1 && (await text('[data-testid=report-passes] summary')) === '1 check passed');
  check('BUILD: the preview has one tab per page, home first, and shows the home page', await chrome.waitFor(`document.querySelectorAll('[data-testid=site-tab]').length === 2`, 15000) && (await chrome.eval(`[...document.querySelectorAll('[data-testid=site-tab]')].map((t) => t.textContent).join()`)) === 'Home,About' && !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`, 15000)), await inFrame(`document.title`));
  check('BUILD: the page is styled by the project\'s stylesheet and has the SDK menu', !!(await waitFrame(`document.querySelectorAll('.vx-nav .vx-link').length >= 1`, 15000)) && (await bodyBg()) !== 'rgba(0, 0, 0, 0)', await bodyBg());
  await chrome.screenshot(`${OUT}/build-built.png`);
  await click('[data-testid=site-tab][data-page="about.html"]');
  check('BUILD: clicking a tab shows that page', !!(await waitFrame(`document.querySelector('h1')?.textContent === 'About us'`, 15000)) && (await chrome.eval(`document.querySelector('[data-testid=site-frame]').dataset.page`)) === 'about.html');
  await inFrame(`document.querySelector('[data-e2e=home-link]').click(); true`);
  check('BUILD: clicking a link between two pages inside the preview moves to that page (and tab)', !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`, 15000)) && (await chrome.eval(`document.querySelector('[data-testid=site-tab].on').dataset.page`)) === 'index.html');
  await inFrame(`document.querySelector('[data-e2e=gone-link]').click(); true`);
  check('BUILD: a link to a page that does not exist stays put and says so', !!(await chrome.waitFor(`document.querySelector('[data-testid=preview-missing-page]')?.textContent.includes('gone.html')`, 5000)) && (await inFrame(`document.querySelector('h1').textContent`)) === 'Bean There', await text('[data-testid=preview-missing-page]'));
  check('BUILD: "Build it again" is offered, with the old site kept until the new one is complete', (await count('[data-testid=build-redo]')) === 1 && (await text('[data-testid=build-redo-box]')).includes('stays until'));

  // "Check again" asks the real ai-chat to verify the saved site and save a fresh report
  const reportBefore = (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.launch_checks&select=version,data`, { headers: svc })).json?.[0];
  await click('[data-testid=build-recheck]');
  const reportAfter = await (async () => { const end = Date.now() + 25000; while (Date.now() < end) { const r = (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.launch_checks&select=version,data`, { headers: svc })).json?.[0]; if (r && r.version > reportBefore.version) return r; await sleep(500); } return null; })();
  check('BUILD: "Check again" saves a new report for this version of the site', !!reportAfter && reportAfter.data.manifest_version === mver && Array.isArray(reportAfter.data.checks) && reportAfter.data.checks.length > 0, JSON.stringify(reportAfter?.data ?? null).slice(0, 300));
  if (reportAfter) {
    check('BUILD: …and the screen shows that report instead (same verdict as the saved one)', !!(await chrome.waitFor(`document.querySelector('[data-testid=build-report]')?.dataset.ok === ${JSON.stringify(String(reportAfter.data.ok))}`, 12000)) && !(await text('[data-testid=build-report]')).includes('gone.html is'), await text('[data-testid=build-report]'));
    info('BUILD recheck report: ' + JSON.stringify(reportAfter.data.checks.filter((c) => c.status !== 'pass').map((c) => `${c.status}:${c.id}`)).slice(0, 300));
  }

  check('BUILD: after the build, the way forward (TWEAKS) is open', (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === false);

  await chrome.viewport(390, 800, true);
  await sleep(400);
  const bm = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('BUILD screen has no horizontal overflow at 390px', bm.sw <= 390 && bm.wide.length === 0, JSON.stringify(bm));
  await chrome.screenshot(`${OUT}/build-mobile.png`);
  await chrome.viewport(1280, 800);
  await sleep(200);

  // the stepper ignores clicks while the move to BUILD is still settling (aria-disabled) — wait for it, like a person would
  await chrome.waitFor(`document.querySelector('.stage[data-stage=example]')?.getAttribute('aria-disabled') !== 'true'`, 8000);
  await click('.stage[data-stage=example]');
  const backOnExample = !!(await chrome.waitFor(`document.querySelector('[data-testid=example-stage]')?.dataset.status === 'locked'`, 10000));
  const stageAfterBack = await dbStage();
  check('…and the stepper brings the owner back to EXAMPLE, locked style intact', backOnExample && stageAfterBack === 'example', `screen ${backOnExample ? 'locked' : await exStatus()} / db ${stageAfterBack}`);

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

  // ── 3g. the TWEAKS screen (Step 11): the site beside a chat — point at something, say what to change, undo it ──
  // The Worker call is stubbed (no model); the test plays the server's part of a change (writes the draft, saves the checkpoint and the chat
  // lines) with the service key, exactly the rows ai-chat writes in production. Undo / redo / "go back to this" are REAL calls to ai-chat.
  // E2E_MOCK_BUILD=1 below runs a real change through the Worker with the stand-in model.
  const twIs = (expr, ms = 8000) => chrome.waitFor(expr, ms);
  const NOW_TEXT = () => text('[data-testid=tweaks-now]');
  const pickedFrame = () => inFrame(`[...document.querySelectorAll('[data-vx-picked]')].map((e) => e.tagName.toLowerCase()).join()`);
  check('TWEAKS: the guided screen replaces the artifact list — the site, the history bar and the chat', !!(await twIs(`!!document.querySelector('[data-testid=tweaks-stage]') && !!document.querySelector('[data-testid=tweaks-chat]') && !!document.querySelector('[data-testid=site-preview]')`, 12000)) && (await count('.artifact')) === 0);
  check('TWEAKS: the site is shown with its own page tab, and nothing is live yet ("Draft")', !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`, 15000)) && (await text('[data-testid=tweaks-draft]')) === 'Draft · not live yet' && (await text('[data-testid=tweaks-draft-note]')).includes('once you publish'), await text('[data-testid=tweaks-draft]'));
  check('TWEAKS: the chat greets the owner and the pointer says nothing is picked', (await count('[data-testid=tweaks-greeting]')) === 1 && (await count('[data-testid=tweaks-nothing-picked]')) === 1 && (await count('[data-testid=tweaks-ideas]')) === 1);
  check('TWEAKS: no saved version yet → undo and redo are off and the bar says so', (await chrome.eval(`document.querySelector('[data-testid=tweaks-undo]').disabled && document.querySelector('[data-testid=tweaks-redo]').disabled`)) === true && (await NOW_TEXT()).includes('No saved versions yet'), await NOW_TEXT());
  check('TWEAKS: the launch report is shown beside it, with a way to check again', (await count('[data-testid=tweaks-report]')) === 1 && (await count('[data-testid=tweaks-recheck]')) === 1);
  await chrome.screenshot(`${OUT}/stage-tweaks.png`);

  // device frames: the page is laid out at the device's real width, whatever room the screen has
  const frameWidth = () => inFrame(`innerWidth`);
  const desktopW = await frameWidth();
  await click('[data-testid=preview-tablet]');
  check('TWEAKS: "Tablet" shows the page at 768px wide, inside a frame that fits the screen', (await chrome.eval(`document.querySelector('.preview-stage').dataset.device`)) === 'tablet' && (await waitFrame(`innerWidth === 768`, 6000)) === true && (await chrome.eval(`(() => { const s = document.querySelector('.preview-stage').getBoundingClientRect(), d = document.querySelector('.preview-stage .device').getBoundingClientRect(); return d.left >= s.left - 1 && d.right <= s.right + 1; })()`)) === true, await chrome.eval(`(() => { const s = document.querySelector('.preview-stage').getBoundingClientRect(), d = document.querySelector('.preview-stage .device'), r = d.getBoundingClientRect(); return JSON.stringify({ device: document.querySelector('.preview-stage').dataset.device, stage: [s.left, s.right], frame: [r.left, r.right], fit: d.dataset.fit, win: innerWidth }); })()`));
  await chrome.screenshot(`${OUT}/tweaks-tablet.png`);
  await click('[data-testid=preview-phone]');
  check('TWEAKS: "Phone" shows it at 390px, so the page\'s phone layout is what you see', (await waitFrame(`innerWidth === 390`, 6000)) === true && (await chrome.eval(`document.querySelector('.preview-stage').dataset.device`)) === 'phone', await frameWidth());
  await chrome.screenshot(`${OUT}/tweaks-phone.png`);
  await click('[data-testid=preview-desktop]');
  check('TWEAKS: "Desktop" gives the page the whole width again', (await waitFrame(`innerWidth === ${desktopW}`, 6000)) === true, `${await frameWidth()} vs ${desktopW}`);

  // pointing: while it is on, a click chooses what is under it and does nothing else
  await click('[data-testid=tweaks-pick]');
  check('TWEAKS: "Point at something" turns pointing on (the page gets a crosshair, the button says Cancel)', !!(await waitFrame(`document.documentElement.hasAttribute('data-vx-picking')`, 6000)) && (await text('[data-testid=tweaks-pick]')).trim() === 'Cancel' && (await chrome.eval(`document.querySelector('.preview-stage').dataset.picking`)) === 'true');
  await inFrame(`document.querySelector('[data-e2e=about-link]').click(); true`);
  check('TWEAKS: pointing at a link picks it — it does NOT follow the link', !!(await twIs(`document.querySelector('[data-testid=tweaks-pointed]')?.dataset.tag === 'a'`, 6000)) && (await count('[data-testid=preview-missing-page]')) === 0 && (await inFrame(`document.querySelector('h1')?.textContent`)) === 'Bean There', await text('[data-testid=tweaks-pointing]'));
  check('TWEAKS: …it says in words what was picked and marks it on the page; pointing turns itself off', (await text('[data-testid=tweaks-pointed]')).includes('Link “About us”') && (await pickedFrame()) === 'a' && (await chrome.eval(`document.querySelector('.preview-stage').dataset.picking`)) === 'false');
  await click('[data-testid=tweaks-pick]');
  await waitFrame(`document.documentElement.hasAttribute('data-vx-picking')`, 6000);
  await inFrame(`document.querySelector('h1').click(); true`);
  check('TWEAKS: "Pick something else" replaces the pick (heading), and only that one is marked', !!(await twIs(`document.querySelector('[data-testid=tweaks-pointed]')?.dataset.tag === 'h1'`, 6000)) && (await text('[data-testid=tweaks-pointed]')).includes('Heading “Bean There”') && (await pickedFrame()) === 'h1', await pickedFrame());
  check('TWEAKS: ideas for what is picked fill the box (nothing is sent until "Make the change")', await (async () => { await click('[data-testid=tweaks-idea]'); return (await chrome.eval(`document.querySelector('[data-testid=chat-input]').value.length > 3`)) === true && (await chrome.eval(`!!window.__tweakBody`)) !== true; })());
  await click('[data-testid=tweaks-unpick]');
  const stillPointed = await count('[data-testid=tweaks-pointed]'), markGone = await waitFrame(`!document.querySelector('[data-vx-picked]')`, 4000);
  check('TWEAKS: ✕ lets go of the pick, on the screen and on the page', stillPointed === 0 && markGone === true, `pointed on screen: ${stillPointed}, mark gone from page: ${markGone}`);
  await click('[data-testid=tweaks-pick]');
  await waitFrame(`document.documentElement.hasAttribute('data-vx-picking')`, 6000);
  await inFrame(`document.querySelector('h1').click(); true`);
  await twIs(`document.querySelector('[data-testid=tweaks-pointed]')?.dataset.tag === 'h1'`, 6000);

  // a change: the request carries the words and the picked element; while it runs the screen is locked and Stop is offered
  const stubTweaks = () => chrome.eval(`(() => { const enc = new TextEncoder(); window.__realFetch4 = window.__realFetch4 || window.fetch; window.__tweakBody = null;
    window.fetch = (input, init) => { const u = typeof input === 'string' ? input : input.url; if (!u.startsWith('https://vexium-ai-build.startafter.workers.dev')) return window.__realFetch4(input, init);
      window.__tweakBody = JSON.parse(init.body); let ctl; const send = (ev, d) => ctl.enqueue(enc.encode('event: ' + ev + '\\ndata: ' + JSON.stringify(d) + '\\n\\n'));
      const body = new ReadableStream({ start(c) { ctl = c; send('stage_job', { job_id: 'e2e-tweak-job', stage: 'tweaks' }); send('start', {}); send('delta', { text: 'Making the title bigger.' }); send('file_start', { name: 'index.html', mode: 'patch' });
        window.__finish = (changed) => { send('stage_done', { ok: true, artifact: null, changed }); ctl.close(); }; window.__cut = () => ctl.close(); } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })); }; return true; })()`);
  await stubTweaks();
  await setValue('[data-testid=chat-input]', 'Make the title bigger');
  await click('[data-testid=chat-send]');
  check('TWEAKS: the request names the stage, the project, the words, and the element that was picked', !!(await chrome.waitFor(`!!window.__tweakBody`, 6000)) && await chrome.eval(`(() => { const b = window.__tweakBody; return b.stage === 'tweaks' && b.project_id === ${JSON.stringify(PID)} && b.stream === true && b.messages[b.messages.length - 1].role === 'user' && b.messages[b.messages.length - 1].content === 'Make the title bigger' && b.pointed.tag === 'h1' && b.pointed.page === 'index.html' && b.pointed.text === 'Bean There' && b.pointed.html.includes('<h1'); })()`), JSON.stringify(await chrome.eval('window.__tweakBody')).slice(0, 300));
  check('TWEAKS: while it runs the chat shows the words arriving and "Making the change…"', !!(await twIs(`document.querySelector('[data-testid=tweaks-working]')?.textContent.includes('Making the change')`, 6000)) && (await text('[data-testid=chat-live]')) === 'Making the title bigger.', await text('[data-testid=tweaks-working]'));
  check('TWEAKS: …the box, the pointer, undo/redo and "Continue" are shut, and Stop is offered', (await chrome.eval(`['chat-input', 'tweaks-pick', 'tweaks-undo', 'tweaks-redo'].every((t) => document.querySelector('[data-testid=' + t + ']').disabled)`)) === true && (await count('[data-testid=chat-stop]')) === 1 && (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === true && (await text('[data-testid=stage-hold]'))?.includes('still being made'), await text('[data-testid=stage-hold]'));
  await chrome.screenshot(`${OUT}/tweaks-running.png`);

  // the server's part: the version before, the changed draft, the version after, and the two chat lines
  const before = await dbFiles();
  const NEW_HOME = before['index.html'].replace('<h1>Bean There</h1>', '<h1>Bean There Roasters</h1>');
  const snap = (kind, label) => rpcSvc('take_site_snapshot', { p_project: PID, p_kind: kind, p_label: label });
  const s1 = await snap('baseline', 'Your site as it was built');
  await sbWrite('PATCH', `projects?id=eq.${PID}`, { files: { ...before, 'index.html': NEW_HOME } });
  const s2 = await snap('tweak', 'Make the title bigger');
  const said = await sbWrite('POST', 'stage_messages', [
    { project_id: PID, stage: 'tweaks', role: 'user', content: 'Make the title bigger', user_id: uid, created_at: new Date(Date.now() - 2000).toISOString() },
    { project_id: PID, stage: 'tweaks', role: 'assistant', content: 'Done — the title is bigger.', user_id: null, created_at: new Date(Date.now() - 1000).toISOString() },
  ]);
  check('TWEAKS (setup): the platform saved the versions, the changed draft and the conversation', s1.status < 300 && s2.status < 300 && s1.json?.created === true && s2.json?.created === true && said.status < 300, `${s1.text} / ${s2.text} / ${said.status}`);
  await chrome.eval(`window.__finish(['index.html']); true`);
  check('TWEAKS: when the run ends the screen says what was updated — and that it is a draft that can be undone', !!(await twIs(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.includes('Updated Home.')`, 12000)) && (await text('[data-testid=tweaks-notice]')).includes('undo it any time'), await text('[data-testid=tweaks-notice]'));
  check('TWEAKS: the preview shows the change at once, on the same page', !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There Roasters'`, 12000)) && (await chrome.eval(`document.querySelector('[data-testid=site-tab].on')?.dataset.page`)) === 'index.html');
  check('TWEAKS: the pick is let go after a change; the chat is the stored conversation (no greeting)', (await count('[data-testid=tweaks-pointed]')) === 0 && (await chrome.eval(`[...document.querySelectorAll('[data-testid=chat-line]')].map((l) => l.dataset.role + ':' + l.textContent).join('|')`)) === 'user:Make the title bigger|assistant:Done — the title is bigger.' && (await count('[data-testid=tweaks-greeting]')) === 0);
  check('TWEAKS: the box, pointer and undo open again; the bar names the version you are on', (await chrome.eval(`document.querySelector('[data-testid=chat-input]').disabled === false && document.querySelector('[data-testid=tweaks-pick]').disabled === false && document.querySelector('[data-testid=tweaks-undo]').disabled === false && document.querySelector('[data-testid=tweaks-redo]').disabled === true`)) === true && (await NOW_TEXT()).includes('Make the title bigger'), await NOW_TEXT());
  check('TWEAKS: the earlier versions are listed, newest first, with this one marked', !!(await twIs(`document.querySelectorAll('[data-testid=tweaks-version]').length === 2`, 6000)) && (await chrome.eval(`[...document.querySelectorAll('[data-testid=tweaks-version]')].map((v) => v.dataset.seq + (v.dataset.current === 'true' ? '*' : '')).join()`)) === `${s2.json.seq}*,${s1.json.seq}`, await chrome.eval(`[...document.querySelectorAll('[data-testid=tweaks-version]')].map((v) => v.dataset.seq).join()`));
  await chrome.screenshot(`${OUT}/tweaks-done.png`);

  // undo / redo / go back — real calls to ai-chat, which moves the draft along the saved versions
  await click('[data-testid=tweaks-undo]');
  check('TWEAKS: Undo puts the old words back in the draft and in the preview, and says so', !!(await twIs(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.startsWith('Undone')`, 15000)) && (await dbFiles())['index.html'] === before['index.html'] && !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`, 12000)), await text('[data-testid=tweaks-notice]'));
  check('TWEAKS: …now Redo is open and Undo is not (this is the oldest version)', (await twIs(`document.querySelector('[data-testid=tweaks-redo]')?.disabled === false && document.querySelector('[data-testid=tweaks-undo]')?.disabled === true`, 8000)) !== false && (await NOW_TEXT()).includes('Your site as it was built'), await NOW_TEXT());
  await click('[data-testid=tweaks-redo]');
  check('TWEAKS: Redo brings the change back', !!(await twIs(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.startsWith('Redone')`, 15000)) && (await dbFiles())['index.html'] === NEW_HOME && !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There Roasters'`, 12000)), await text('[data-testid=tweaks-notice]'));
  await chrome.eval(`document.querySelector('[data-testid=tweaks-versions]').open = true; true`);
  await click(`[data-testid=tweaks-version][data-seq="${s1.json.seq}"] [data-testid=tweaks-restore]`);
  check('TWEAKS: "Go back to this" on an earlier version restores exactly that version', !!(await twIs(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.includes('Your site is back at')`, 15000)) && (await dbFiles())['index.html'] === before['index.html'] && !!(await waitFrame(`document.querySelector('h1')?.textContent === 'Bean There'`, 12000)), await text('[data-testid=tweaks-notice]'));
  check('TWEAKS: undo and restore leave the other files and the project\'s stage alone', (await dbFiles())['site.js'] === before['site.js'] && (await dbFiles())['styles.css'] === before['styles.css'] && (await dbStage()) === 'tweaks');

  // a connection cut mid-change: said in plain words, nothing is claimed
  await chrome.eval(`window.fetch = window.__realFetch4; true`);
  await stubTweaks();
  await setValue('[data-testid=chat-input]', 'Make the button purple');
  await click('[data-testid=chat-send]');
  await twIs(`!!document.querySelector('[data-testid=tweaks-working]')`, 6000);
  await chrome.eval(`window.__cut(); true`);
  check('TWEAKS: a run cut off before the end says it was interrupted, claims no change, and gives the message back', !!(await twIs(`document.querySelector('[data-testid=chat-error]')?.textContent.includes('interrupted')`, 12000)) && (await count('[data-testid=tweaks-notice]')) === 0 && (await chrome.eval(`document.querySelector('[data-testid=chat-input]').value`)) === 'Make the button purple', await text('[data-testid=chat-error]'));
  await chrome.eval(`window.fetch = window.__realFetch4; true`);
  await setValue('[data-testid=chat-input]', '');

  // the same screen on a phone
  await chrome.viewport(390, 800, true);
  await sleep(500);
  const tm = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5 && !e.closest('.preview-stage')).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('TWEAKS screen has no horizontal overflow at 390px', tm.sw <= 390 && tm.wide.length === 0, JSON.stringify(tm));
  await chrome.screenshot(`${OUT}/tweaks-mobile.png`);
  await chrome.viewport(1280, 800);
  await sleep(300);

  // editing the plan makes everything built from it stale — flagged in the stepper, the cards, and the way forward
  await put('plan', { ...PLAN, name: PROJECT_NAME + ' (edited)' });
  await reloadProject();
  check('after a plan edit the stepper flags the stages whose result is out of date', (await chrome.eval(`[...document.querySelectorAll('.stage.attention')].map(e => e.dataset.stage).sort().join()`)) === 'build,example,tweaks', await chrome.eval(`[...document.querySelectorAll('.stage.attention')].map(e => e.dataset.stage).join()`));
  check('the TWEAKS screen says the built site is out of date and offers "Keep it as it is"', (await count('[data-testid=tweaks-outdated]')) === 1 && (await count('[data-testid=tweaks-keep-site]')) === 1, await text('[data-testid=tweaks-stage]'));
  check('…and while the style is out of date no change can be made (box and pointer shut, the way out is right there)', (await count('[data-testid=tweaks-blocker]')) === 1 && (await count('[data-testid=tweaks-keep-style]')) === 1 && (await chrome.eval(`document.querySelector('[data-testid=chat-input]').disabled && document.querySelector('[data-testid=tweaks-pick]').disabled`)) === true, await text('[data-testid=tweaks-blocker]'));
  check('LAUNCH is blocked again ("out of date")', (await stepState('launch')) === 'blocked' && (await text('[data-testid=stage-why]')).includes('out of date'), await text('[data-testid=stage-why]'));
  check('the current stage was NOT yanked away from the user', (await dbStage()) === 'tweaks');
  await chrome.screenshot(`${OUT}/stage-stale.png`);
  await click('[data-testid=tweaks-keep-style]');
  check('"Keep style as it is" clears its flag in the UI and the database, and the box opens for changes again', await chrome.waitFor(`!document.querySelector('[data-testid=tweaks-keep-style]') && !document.querySelector('[data-testid=tweaks-blocker]')`, 8000)
    && (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.style_spec&select=stale`, { headers: svc })).json?.[0]?.stale === false
    && (await chrome.eval(`document.querySelector('[data-testid=chat-input]').disabled`)) === false);
  await click('[data-testid=tweaks-keep-site]');
  check('"Keep it as it is" on the built site clears its flag too', await chrome.waitFor(`!document.querySelector('[data-testid=tweaks-outdated]')`, 8000)
    && (await jfetch(`${SB}/rest/v1/project_artifacts_latest?project_id=eq.${PID}&kind=eq.manifest&select=stale`, { headers: svc })).json?.[0]?.stale === false);

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

  // ── the FULL BUILD screen driven through the real Worker/Workflow (E2E_AI=1: a real model; E2E_MOCK_BUILD=1: the stand-in model) ──
  const realBuild = async ({ id, planned, tag, shot }) => {
    const ai2 = (sql) => jfetch(`${SB}/rest/v1/${sql}`, { headers: svc });
    // The whole site from the plan and the locked style, through the real Workflow: it builds every page, the verifier checks it.
    // Starts on a project at EXAMPLE with a locked style: Continue moves to BUILD. `planned` = the file names the plan lists.
    await click('[data-testid=stage-continue]');
    check(tag + ': ' + 'Continue moves on to BUILD, which offers to build the full site', await chrome.waitFor(`!!document.querySelector('[data-testid=build-start]')`, 15000));
    const t0 = Date.now();
    await click('[data-testid=build-start]');
    check(tag + ': ' + 'the build starts and shows its checklist', !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=build-progress] li').length >= 3`, 90000)), (await text('[data-testid=build-start-error]')) + ' | ' + (await bsStatus()));
    await chrome.screenshot(`${OUT}/${shot}-running.png`);
    const finished = await chrome.waitFor(`['built', 'failed'].includes(document.querySelector('[data-testid=build-stage]')?.dataset.status)`, 30 * 60 * 1000);
    const builtOk = (await bsStatus()) === 'built';
    check(tag + ': ' + 'the build finishes ("Built")', !!finished && builtOk, (await bsStatus()) + ' | ' + (await text('[data-testid=job-failed]')) + ' | ' + (await text('[data-testid=build-start-error]')));
    info(`${tag}: took ${Math.round((Date.now() - t0) / 1000)}s`);
    const lastJob = (await ai2(`build_jobs?project_id=eq.${id}&stage=eq.build&select=id,status,error&order=created_at.desc&limit=1`)).json?.[0];
    info(tag + ' job: ' + JSON.stringify(lastJob));
    if (lastJob?.id) info(tag + ' steps: ' + JSON.stringify(((await ai2(`build_steps?job_id=eq.${lastJob.id}&select=seq,kind,file,status,attempt,detail,cost_cents&order=seq`)).json ?? []).map((s) => `${s.seq}:${s.kind}:${s.file ?? ''}:${s.status}:a${s.attempt}:${s.cost_cents}${s.detail ? ':' + s.detail.slice(0, 60) : ''}`)));
    if (builtOk) {
      const man = (await ai2(`project_artifacts_latest?project_id=eq.${id}&kind=eq.manifest&select=version,data`)).json?.[0];
      const rep = (await ai2(`project_artifacts_latest?project_id=eq.${id}&kind=eq.launch_checks&select=version,data`)).json?.[0];
      const site = (await ai2(`projects?id=eq.${id}&select=files`)).json?.[0]?.files ?? {};
                const built = (man?.data?.pages ?? []).map((p) => p.file);
      info(tag + ' manifest: ' + JSON.stringify(man?.data ?? null).slice(0, 700));
      info(tag + ' report: ' + JSON.stringify((rep?.data?.checks ?? []).filter((c) => c.status !== 'pass')).slice(0, 1200));
      check(tag + ': ' + 'every page in the plan was built (and no others)', planned.length >= 1 && planned.every((f) => built.includes(f)) && built.length === planned.length, `plan ${planned.join()} / built ${built.join()}`);
      check(tag + ': ' + 'every page, the stylesheet and site.js are real files in the project', [...planned, 'styles.css', 'site.js'].every((f) => typeof site[f] === 'string' && site[f].length > 400), Object.entries(site).map(([k, v]) => `${k}=${String(v).length}`).join(' '));
      const text2 = planned.map((f) => site[f] ?? '').join('\n') + (site['site.js'] ?? '');
      check(tag + ': ' + 'zero placeholder content (no lorem ipsum, TODO, "coming soon", unfilled {{ }}, example.com)', !/lorem ipsum|\bTODO\b|coming soon|insert .{0,20} here|example\.com|\{\{(?!VEXIUM_PROJECT_ID)/i.test(text2), (text2.match(/lorem ipsum|\bTODO\b|coming soon|insert .{0,20} here|example\.com|\{\{(?!VEXIUM_PROJECT_ID)/i) ?? [''])[0]);
      check(tag + ': ' + 'the launch report is saved for this version of the site and has no failures', !!rep && rep.data.manifest_version === man.version && rep.data.ok === true && rep.data.checks.every((c) => c.status !== 'fail'), JSON.stringify(rep?.data?.checks?.filter((c) => c.status === 'fail') ?? null).slice(0, 400));
      check(tag + ': ' + 'the screen shows the passing report', (await chrome.eval(`document.querySelector('[data-testid=build-report]')?.dataset.ok`)) === 'true', await text('[data-testid=build-report]'));
      check(tag + ': ' + 'the cost of the build was counted (manifest and screen agree)', typeof man?.data?.cost_cents === 'number' && man.data.cost_cents > 0 && (await text('[data-testid=build-summary]')).includes('Build cost'), `${man?.data?.cost_cents} / ${await text('[data-testid=build-summary]')}`);
      check(tag + ': ' + 'the preview has a tab for every page and each one draws a headline', await (async () => {
        const tabs = await chrome.eval(`[...document.querySelectorAll('[data-testid=site-tab]')].map((t) => t.dataset.page)`);
        if (tabs.length !== planned.length) return false;
        for (const f of tabs) {
          await click(`[data-testid=site-tab][data-page="${f}"]`);
          if (!(await waitFrame(`document.querySelector('h1')?.textContent.trim().length > 2 && document.querySelectorAll('.vx-nav .vx-link').length >= 1`, 20000))) return false;
        }
        return true;
      })());
      check(tag + ': ' + 'no page reports an error in the preview', (await count('[data-testid=preview-problem]')) === 0, await text('[data-testid=preview-problem]'));
      await chrome.screenshot(`${OUT}/${shot}-built.png`);
      check(tag + ': ' + 'Continue is open to TWEAKS', (await chrome.eval(`document.querySelector('[data-testid=stage-continue]').disabled`)) === false);
    }
  };

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

    // …then the landing page from that plan, for real: build → look at it → change the vibe (no AI) → lock.
    if (replied && aiPlan) {
      const ai2 = (sql) => jfetch(`${SB}/rest/v1/${sql}`, { headers: svc });
      await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]')?.disabled === false`, 10000);
      await click('[data-testid=stage-continue]');
      check('AI EXAMPLE: Continue moves the new project to EXAMPLE, which offers to build the page', await chrome.waitFor(`!!document.querySelector('[data-testid=example-build]')`, 15000));
      await click('[data-testid=example-build]');
      const built = await chrome.waitFor(`!!document.querySelector('[data-testid=vibe-controls]') && document.querySelector('[data-testid=example-stage]')?.dataset.status === 'unlocked'`, 420000);
      check('AI EXAMPLE: the page is built and the controls open (status "Not locked yet")', built, (await text('[data-testid=example-run-error]')) + ' | ' + (await exStatus()));
      if (!built) info('AI EXAMPLE worker stream: ' + JSON.stringify((await chrome.eval('window.__workerText')).slice(-900)));
      if (built) {
        const row = (await ai2(`project_artifacts_latest?project_id=eq.${newId}&kind=eq.style_spec&select=version,data`)).json?.[0];
        const files = (await ai2(`projects?id=eq.${newId}&select=files`)).json?.[0]?.files ?? {};
        info('AI EXAMPLE style: ' + JSON.stringify(row?.data ?? null).slice(0, 900));
        info('AI EXAMPLE files: ' + Object.entries(files).map(([k, v]) => `${k}=${String(v).length}`).join(' '));
        check('AI EXAMPLE: four files were written (page, styles, site.js, manifest)', ['index.html', 'styles.css', 'site.js', 'manifest.json'].every((f) => typeof files[f] === 'string' && files[f].length > 50), Object.keys(files).join());
        check('AI EXAMPLE: the page is real (not a stub), links the stylesheet, and has no placeholder text', files['index.html']?.length > 2500 && /href="styles\.css"/.test(files['index.html']) && !/lorem ipsum|\{\{(?!VEXIUM_PROJECT_ID)/i.test(files['index.html']), String(files['index.html']?.length));
        check('AI EXAMPLE: a StyleSpec was saved, unlocked, with colour tokens and two fonts', row?.data?.locked === false && !!row.data.tokens?.['--accent'] && !!row.data.tokens?.['--bg'] && !!row.data.fonts?.display && !!row.data.fonts?.body, JSON.stringify(row?.data?.tokens ?? null).slice(0, 200));
        check('AI EXAMPLE: the stylesheet in the project matches the saved style (nothing "unsaved" right after a build)', (await exStatus()) === 'unlocked' && (await count('[data-testid=style-save]')) === 0);
        check('AI EXAMPLE: the page draws in the preview with a headline and the SDK menu', !!(await waitFrame(`document.querySelector('h1')?.textContent.trim().length > 2 && document.querySelectorAll('.vx-nav .vx-link').length >= 1`, 20000)), await inFrame(`document.title`));
        check('AI EXAMPLE: the page\'s own code reports no errors', (await count('[data-testid=preview-problem]')) === 0, await text('[data-testid=preview-problem]'));
        await chrome.screenshot(`${OUT}/ai-example-built.png`);
        const t1 = Date.now();
        await click('[data-testid=vibe-theme-dark]');
        const reskinned = await waitFrame(`(() => { const n = (getComputedStyle(document.body).backgroundColor.match(/\\d+/g) || []).map(Number); return n[0] + n[1] + n[2] < 300; })()`, 5000);
        check('AI EXAMPLE: "Dark" re-skins the real page within seconds, without the AI', reskinned === true && Date.now() - t1 < 4000, `${Date.now() - t1}ms`);
        await chrome.screenshot(`${OUT}/ai-example-dark.png`);
        await click('[data-testid=style-lock]');
        check('AI EXAMPLE: "Save and lock" stores the dark look as locked, and Continue opens', await exStatusIs('locked') && (await ai2(`project_artifacts_latest?project_id=eq.${newId}&kind=eq.style_spec&select=version,data`)).json?.[0]?.data?.locked === true && await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]').disabled === false`, 8000));

        await realBuild({ id: newId, planned: aiPlan.data.pages.map((p) => p.file), tag: 'AI BUILD', shot: 'ai-build' });
      }
    }
  } else if (process.env.E2E_MOCK_BUILD) {
    // The real Workflow, ai-chat, verifier and database, with the pages written by a stand-in for the model (cf-worker/mock/anthropic.ts,
    // deployed by hand for the run — docs/INFRA.md "Testing the build without credit"). Spends no credit; proves the screen against a live build.
    await chrome.eval(`window.fetch = window.__realFetch; true`);
    const MOCK_PAGES = [
      { file: 'index.html', title: 'Home', purpose: 'Introduce the candles' },
      { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' },
      { file: 'contact.html', title: 'Contact', purpose: 'Get in touch mock-flaw' }, // the stand-in breaks this page's first attempt → the repair loop runs
      { file: 'about.html', title: 'About', purpose: 'Who pours the candles' },
    ];
    const mockPlan = { ...PLAN, name: 'Wick & Co', one_liner: 'Hand-poured soy candles', audience: 'People who like a warm room', offer: 'Small-batch candles', pricing: { model: 'one_time', items: [{ name: 'Amber candle', price_cents: 2400 }] }, pages: MOCK_PAGES, backend: { collections: [], products: ['Amber candle'], forms: ['contact'], auth: false } };
    const example = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Wick & Co</title><link rel="stylesheet" href="styles.css"/></head><body><header data-vx-nav></header><main><section id="top"><h1>Candles poured by hand</h1><p>Small-batch soy candles, poured one at a time and shipped to your door.</p><a href="#top">See the candles</a></section></main><footer data-vx-footer></footer><script src="site.js"></script></body></html>';
    const seed = async (kind, data) => rpcSvc('put_project_artifact', { p_project: newId, p_kind: kind, p_data: data });
    await seed('plan', mockPlan);
    await seed('style_spec', STYLE);
    await jfetch(`${SB}/rest/v1/projects?id=eq.${newId}`, { method: 'PATCH', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ files: { 'index.html': example, 'styles.css': ':root { --bg: #ffffff; --text: #111111; --accent: #7c3aed; }\nbody { background: var(--bg); color: var(--text); }\n' } }) });
    await reloadProject();
    await click('[data-testid=stage-continue]');
    check('MOCK BUILD: Continue from the plan opens EXAMPLE with the locked style', await chrome.waitFor(`document.querySelector('[data-testid=example-stage]')?.dataset.status === 'locked'`, 15000), await exStatus());
    await realBuild({ id: newId, planned: MOCK_PAGES.map((p) => p.file), tag: 'MOCK BUILD', shot: 'mock-build' });
    const lastBuild = (await jfetch(`${SB}/rest/v1/build_jobs?project_id=eq.${newId}&stage=eq.build&select=id&order=created_at.desc&limit=1`, { headers: svc })).json?.[0];
    const fixSteps = lastBuild ? ((await jfetch(`${SB}/rest/v1/build_steps?job_id=eq.${lastBuild.id}&kind=eq.fix&select=file,status`, { headers: svc })).json ?? []) : [];
    check('MOCK BUILD: the launch checks caught the broken contact page and it was repaired before saving', fixSteps.some((f) => f.file === 'contact.html' && f.status === 'done'), JSON.stringify(fixSteps));

    // ── TWEAKS through the real Worker, ai-chat, finisher and database, with the stand-in model: words, then a colour, then the failures ──
    const mdb = async (path) => (await jfetch(`${SB}/rest/v1/${path}`, { headers: svc })).json;
    const mFiles = async () => (await mdb(`projects?id=eq.${newId}&select=files`))?.[0]?.files ?? {};
    const mArt = async (kind) => (await mdb(`project_artifacts_latest?project_id=eq.${newId}&kind=eq.${kind}&select=version,data,stale`))?.[0];
    const mStage = async () => (await mdb(`projects?id=eq.${newId}&select=stage`))?.[0]?.stage;
    const mVersions = async () => (await mdb(`site_snapshots?project_id=eq.${newId}&select=seq,kind,label,is_current&order=seq`)) ?? [];
    const tweakDone = (ms) => chrome.waitFor(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.includes('in your draft') || !!document.querySelector('[data-testid=chat-error]')`, ms);
    const settled = () => chrome.waitFor(`document.querySelector('[data-testid=tweaks-stage]')?.dataset.busy === 'false'`, 40000); // a notice shows before the files and the history are re-read; clicks are ignored until then
    const askTweak = async (words) => { await chrome.waitFor(`!document.querySelector('[data-testid=tweaks-working]') && !!document.querySelector('[data-testid=chat-send]')`, 60000); await chrome.eval(`document.querySelector('[data-testid=tweaks-notice]')?.remove?.(); true`); await setValue('[data-testid=chat-input]', words); await click('[data-testid=chat-send]'); };
    const pointAt = async (selector) => {
      await click('[data-testid=tweaks-pick]');
      await waitFrame(`document.documentElement.hasAttribute('data-vx-picking')`, 6000);
      await inFrame(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
      return !!(await chrome.waitFor(`!!document.querySelector('[data-testid=tweaks-pointed]')`, 6000));
    };

    await click('[data-testid=stage-continue]');
    check('MOCK TWEAKS: Continue from BUILD opens the TWEAKS screen with the built site', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=tweaks-stage]') && !!document.querySelector('[data-testid=site-frame]')`, 20000)) && (await mStage()) === 'tweaks', await mStage());
    const home0 = await waitFrame(`document.querySelector('h1')?.textContent.trim()`, 20000);
    check('MOCK TWEAKS: the built home page is in the preview, and the build is already saved as the first version', typeof home0 === 'string' && home0.length > 2 && !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=tweaks-version]').length === 0 && /Full build/.test(document.querySelector('[data-testid=tweaks-now]')?.textContent ?? '')`, 10000)) && (await mVersions()).length === 1, `${home0} | ${await text('[data-testid=tweaks-now]')} | ${JSON.stringify(await mVersions())}`);
    await chrome.screenshot(`${OUT}/mock-tweaks-start.png`);

    // 1. words: point at the headline, say what it should say
    const before1 = await mFiles();
    check('MOCK TWEAKS: pointing at the headline picks it', await pointAt('h1') && (await text('[data-testid=tweaks-pointed]')).includes(home0.slice(0, 10)), await text('[data-testid=tweaks-pointing]'));
    await askTweak('mock-say "Hand-poured candles, made slowly"');
    check('MOCK TWEAKS: the change is made and the screen says what was updated', !!(await tweakDone(150000)) && (await text('[data-testid=tweaks-notice]'))?.includes('Updated Home.'), (await text('[data-testid=tweaks-notice]')) + ' | ' + (await text('[data-testid=chat-error]')));
    const after1 = await mFiles();
    check('MOCK TWEAKS: only the headline changed in the draft — the new words are in, the old ones are out, the other files are as they were', (/<h1[^>]*>([^<]*)<\/h1>/.exec(after1['index.html'])?.[1] ?? '').trim() === 'Hand-poured candles, made slowly' && Object.keys(before1).every((f) => f === 'index.html' || after1[f] === before1[f]), Object.keys(after1).filter((f) => after1[f] !== before1[f]).join());
    check('MOCK TWEAKS: the preview shows the new words', !!(await waitFrame(`document.querySelector('h1')?.textContent.trim() === 'Hand-poured candles, made slowly'`, 15000)));
    const lines1 = await chrome.eval(`[...document.querySelectorAll('[data-testid=chat-line]')].map((l) => l.dataset.role + ':' + l.textContent)`);
    check('MOCK TWEAKS: the chat has the request and a plain-words answer (no edit markup)', lines1.length === 2 && lines1[0] === 'user:mock-say "Hand-poured candles, made slowly"' && lines1[1].startsWith('assistant:') && !/<patch|<find|<replace/.test(lines1[1]), JSON.stringify(lines1));
    const vs1 = await mVersions();
    check('MOCK TWEAKS: the change is a saved version after the build, and it is where the site is now', vs1.length === 2 && vs1[0].kind === 'stage' && vs1[1].kind === 'tweak' && vs1[1].is_current === true && !vs1[0].is_current, JSON.stringify(vs1));
    const rep1 = await mArt('launch_checks'), man1 = await mArt('manifest');
    check('MOCK TWEAKS: the launch report was re-run on the changed site (it is for the current build of the site)', rep1?.data?.manifest_version === man1?.version && !man1?.stale && (await count('[data-testid=tweaks-outdated]')) === 0, JSON.stringify({ r: rep1?.data?.manifest_version, m: man1?.version }));
    check('MOCK TWEAKS: the pick was let go, the box is open again, "Continue" is open', (await count('[data-testid=tweaks-pointed]')) === 0 && (await chrome.eval(`document.querySelector('[data-testid=chat-input]').disabled`)) === false && !!(await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]')?.disabled === false`, 8000)));
    await chrome.screenshot(`${OUT}/mock-tweaks-words.png`);

    // 2. a question is not an edit: an answer, no new version
    await askTweak('what else could I change here?');
    check('MOCK TWEAKS: a question gets an answer and changes nothing (same files, no new version, no "updated" notice)', !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=chat-line]').length === 4`, 90000)) && (await count('[data-testid=tweaks-notice]')) === 0 && JSON.stringify(await mFiles()) === JSON.stringify(after1) && (await mVersions()).length === 2, (await chrome.eval(`document.querySelectorAll('[data-testid=chat-line]').length`)) + ' lines');

    // 3. a change that cannot be applied is thrown away whole
    await askTweak('mock-bad-find please');
    check('MOCK TWEAKS: an edit that does not fit the page is refused in plain words and NOTHING is half-applied', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=chat-error]')`, 90000)) && JSON.stringify(await mFiles()) === JSON.stringify(after1) && (await mVersions()).length === 2, (await text('[data-testid=chat-error]')));
    // 4. a change that would break the site's forms is refused (forms belong to the plan)
    await askTweak('mock-hook please');
    check('MOCK TWEAKS: a change that would break a form is refused too, and the draft is untouched', !!(await chrome.waitFor(`document.querySelector('[data-testid=chat-error]')?.textContent !== ${JSON.stringify(await text('[data-testid=chat-error]'))} || (document.querySelectorAll('[data-testid=chat-line]').length >= 8 && !document.querySelector('[data-testid=tweaks-working]'))`, 90000)) && JSON.stringify(await mFiles()) === JSON.stringify(after1) && (await mVersions()).length === 2, (await text('[data-testid=chat-error]')));

    // 5. colour: no pointing, the whole site — the stylesheet, the saved style and the manifest follow, nothing is left "out of date"
    await askTweak('mock-accent #2f7d4f');
    check('MOCK TWEAKS: a colour change updates the stylesheet', !!(await tweakDone(150000)) && /--accent:\s*#2f7d4f/i.test((await mFiles())['styles.css'] ?? ''), (await text('[data-testid=tweaks-notice]')) + ' | ' + (await text('[data-testid=chat-error]')));
    const style2 = await mArt('style_spec'), man2 = await mArt('manifest'), rep2 = await mArt('launch_checks');
    check('MOCK TWEAKS: …the saved style has the new colour and is still locked, and nothing is flagged out of date', style2?.data?.tokens?.['--accent']?.toLowerCase() === '#2f7d4f' && style2.data.locked === true && !style2.stale && !man2?.stale && rep2?.data?.manifest_version === man2?.version && (await count('[data-testid=tweaks-outdated]')) === 0 && (await count('[data-testid=tweaks-blocker]')) === 0, JSON.stringify({ a: style2?.data?.tokens?.['--accent'], l: style2?.data?.locked, s: [style2?.stale, man2?.stale], r: rep2?.data?.manifest_version, m: man2?.version }));
    const accentNow = await waitFrame(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#2f7d4f'`, 15000);
    check('MOCK TWEAKS: …and the preview already uses it', accentNow === true);
    check('MOCK TWEAKS: that is a third version in the history', (await mVersions()).length === 3);
    await chrome.screenshot(`${OUT}/mock-tweaks-colour.png`);

    // 6. undo twice (colour, then words), redo once, go back to the build
    await settled(); await click('[data-testid=tweaks-undo]');
    check('MOCK TWEAKS: Undo takes the colour back — in the draft, the saved style and the preview', !!(await chrome.waitFor(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.startsWith('Undone')`, 30000)) && !/--accent:\s*#2f7d4f/i.test((await mFiles())['styles.css'] ?? '') && (await mArt('style_spec'))?.data?.tokens?.['--accent']?.toLowerCase() !== '#2f7d4f' && (await mFiles())['index.html'] === after1['index.html'], await text('[data-testid=tweaks-notice]'));
    await settled(); info('MOCK TWEAKS report after 1st Undo: ' + JSON.stringify((await mArt('launch_checks'))?.data?.problems?.filter?.((p) => p.severity === 'fail') ?? (await mArt('launch_checks'))?.data).slice(0, 700));
    await click('[data-testid=tweaks-undo]');
    check('MOCK TWEAKS: a second Undo takes the words back', !!(await chrome.waitFor(`document.querySelector('[data-testid=tweaks-undo]')?.disabled === true`, 30000)) && JSON.stringify(await mFiles()) === JSON.stringify(before1) && !!(await waitFrame(`document.querySelector('h1')?.textContent.trim() === ${JSON.stringify(home0)}`, 15000)), await text('[data-testid=tweaks-notice]'));
    check('MOCK TWEAKS: the draft is exactly the freshly built site again (every file as it was)', JSON.stringify(await mFiles()) === JSON.stringify(before1));
    await settled(); await click('[data-testid=tweaks-redo]');
    check('MOCK TWEAKS: Redo brings the words back', !!(await chrome.waitFor(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.startsWith('Redone')`, 30000)) && (await mFiles())['index.html'] === after1['index.html'] && !!(await waitFrame(`document.querySelector('h1')?.textContent.trim() === 'Hand-poured candles, made slowly'`, 15000)), await text('[data-testid=tweaks-notice]'));
    // a new change after going back drops the redo branch (the colour version) — the line stays a line
    await askTweak('mock-accent #8a3b12');
    check('MOCK TWEAKS: a new change made after going back replaces the versions that were ahead (still three versions, newest is current)', !!(await tweakDone(150000)) && (await mVersions()).length === 3 && (await mVersions())[2].is_current === true && /#8a3b12/i.test((await mFiles())['styles.css'] ?? ''), JSON.stringify(await mVersions()));
    await chrome.eval(`document.querySelector('[data-testid=tweaks-versions]').open = true; true`);
    const firstSeq = (await mVersions())[0].seq;
    await settled(); await click(`[data-testid=tweaks-version][data-seq="${firstSeq}"] [data-testid=tweaks-restore]`);
    check('MOCK TWEAKS: "Go back to this" on the build returns the whole site to it', !!(await chrome.waitFor(`document.querySelector('[data-testid=tweaks-notice]')?.textContent.includes('Your site is back at')`, 30000)) && JSON.stringify(await mFiles()) === JSON.stringify(before1), await text('[data-testid=tweaks-notice]'));
    check('MOCK TWEAKS: and none of this published anything (the draft is all that moved)', (await mdb(`projects?id=eq.${newId}&select=published_at,published_version,published_files`))?.[0]?.published_at == null);
    await chrome.screenshot(`${OUT}/mock-tweaks-end.png`);
  }

  await chrome.eval(`if (window.__realFetch) window.fetch = window.__realFetch; location.hash = '#/p/does-not-exist'; true`);
  check('unknown project id → "Project not found"', await chrome.waitFor(`document.body.textContent.includes('Project not found')`, 15000)); // the live site answers a lookup slower than the local one
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

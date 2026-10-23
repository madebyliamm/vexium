#!/usr/bin/env node
// Step 13 (chunk B) evidence: the BUSINESS screen in a real (headless) Chrome against the REAL `business-state` function, database and
// publisher (a throwaway user and three live projects whose traffic / sales / sign-ups are seeded at known times with the service key; the
// stage artifacts are written the way the build writes them, so no model credit is spent).
//
//   (cd studio && npm run build) && node scripts/assemble-site.mjs      # produce _site/
//   node studio/test/business_e2e.mjs                                   # serves _site/ on localhost and tests that
//   E2E_BASE=https://vexium.ai node studio/test/business_e2e.mjs        # tests the deployed studio instead
//
// Needs: Google Chrome, the `supabase` CLI logged in (service key), network. "Update live site" publishes to the real `*.vexium.ai`; the user,
// projects and (best effort, needs `wrangler` logged in) R2 objects are deleted in `finally`. Screenshots: /tmp/studio-e2e/business-*.png.
// Use dangerouslyDisableSandbox with the Bash tool.
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
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-business-e2e)' };

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
const username = `vxbizui${rand}`;
const email = `${username}@vexium.ai`;
const password = 'Biz-ui-e2e-' + rand + '!9';
const PID = 'e2e-biz-' + rand;           // a shop with real numbers
const PID_NONE = 'e2e-biz-n-' + rand;    // live, nobody has visited
const PID_EARLY = 'e2e-biz-e-' + rand;   // live, five visitors
const NAME = 'Bean There';
const SLUG = `bean-${rand}`;
const iso = (daysAgo, h = 12) => new Date(Date.now() - daysAgo * 86400e3 + (h - 12) * 3600e3).toISOString();
const siteFiles = (headline) => ({
  'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${NAME}</title><link rel="stylesheet" href="styles.css"></head><body><h1>${headline}</h1><p>Fresh coffee, roasted daily.</p><script src="site.js"></script></body></html>`,
  'styles.css': ':root{--accent:#7c3aed}body{font-family:system-ui;color:#111}h1{color:var(--accent)}',
  'site.js': 'window.__site = true;',
  _backend: JSON.stringify({ collections: [], products: [], forms: [], auth: false }),
});
const manifest = (products) => ({ schema: 1, built_at: new Date().toISOString(), pages: [{ file: 'index.html', title: 'Home', in_nav: true }], shared_files: ['styles.css', 'site.js'], backend: { collections: [], products, forms: [], auth: false }, cost_cents: 0 });
const report = (manifestVersion, checks, open = []) => ({ schema: 1, checked_at: new Date().toISOString(), manifest_version: manifestVersion, ok: !checks.some((c) => c.status === 'fail'), checks, open_items: open });
const PASS = [{ id: 'pages', label: 'Every page was built', status: 'pass' }, { id: 'links', label: 'Every link goes somewhere', status: 'pass' }];

let uid = null, chrome = null, local = null;
try {
  // ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: J, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  uid = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  const SESSION = r.json;

  const post = (path, body) => jfetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { ...J, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  const patch = (path, body) => jfetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...J, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  const rpc = (name, body) => jfetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  const put = async (pid, kind, data) => (await rpc('put_project_artifact', { p_project: pid, p_kind: kind, p_data: data })).json?.version;
  const seedChecks = async (products, checks = PASS, open = []) => {
    const mv = await put(PID, 'manifest', manifest(products));
    await put(PID, 'launch_checks', report(mv, checks, open));
  };

  const live = (pid, slug, extra = {}) => ({ id: pid, user_id: uid, name: NAME, emoji: '☕', files: siteFiles('Bean There'), main_file: 'index.html', published_slug: slug, published_version: 1, published_at: iso(10), is_public: true, stage: 'business', ...extra });
  for (const [pid, slug] of [[PID, SLUG], [PID_NONE, SLUG + '-n'], [PID_EARLY, SLUG + '-e']]) {
    r = await post('projects', live(pid, slug));
    if (r.status >= 300) throw new Error('create project failed: ' + r.text);
    r = await post('project_deploys', { project_id: pid, version: 1, status: 'ready', created_by: uid, created_at: iso(10) });
    if (r.status >= 300) throw new Error('create deploy failed: ' + r.text);
  }
  await put(PID, 'plan', { schema: 1, name: NAME, kind: 'site', one_liner: 'x', audience: 'y', offer: 'z', pricing: { model: 'one_time', items: [] }, pages: [{ file: 'index.html', title: 'Home', purpose: 'p' }], backend: { collections: [], products: ['beans'], forms: [], auth: false }, launch_checklist: [], scenario: { price_cents: 2000, monthly_visitors: 300, conversion_pct: 2 } });
  await put(PID, 'style_spec', { schema: 1, locked: true, vibe: { theme: 'light', density: 'comfortable', tone: 'warm' }, tokens: { '--accent': '#7c3aed' }, fonts: { display: 'Fraunces', body: 'Inter' } });
  await seedChecks(['beans']);

  // 60 visitors in the last 9 days; 25 in the 30 days before (so a trend arrow is allowed); 5 sales-worth of rows; 1 sign-up; 1 form entry.
  const views = [];
  for (let i = 0; i < 60; i++) views.push({ project_id: PID, page: i % 3 ? '/' : '/shop.html', referrer: i % 2 ? 'https://www.google.com/' : '', device: i % 4 ? 'mobile' : 'desktop', session_id: 's' + i, visitor_id: 'v' + i, ts: iso(1 + (i % 9), 8 + (i % 8)) });
  for (let i = 0; i < 25; i++) views.push({ project_id: PID, page: '/', referrer: '', device: 'desktop', session_id: 'o' + i, visitor_id: 'old' + i, ts: iso(35 + (i % 10)) });
  await post('page_views', views);
  await post('site_data', [
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(2) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(3) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 8, currency: 'usd', status: 'paid', description: 'Mug' }, created_at: iso(4) },
    { project_id: PID, collection: 'transactions', data: { type: 'refund', amount: -8, currency: 'usd', status: 'refunded', description: 'Refund issued' }, created_at: iso(1) },
    { project_id: PID, collection: 'contact', data: { name: 'Ann', email: 'ann@example.test' }, created_at: iso(2) },
  ]);
  await post('site_users', [{ project_id: PID, email: `a${rand}@x.test`, password_hash: 'x', created_at: iso(2) }]);
  const early = [];
  for (let i = 0; i < 5; i++) early.push({ project_id: PID_EARLY, page: '/', referrer: '', device: 'mobile', session_id: 'e' + i, visitor_id: 'e' + i, ts: iso(1, 10 + i) });
  await post('page_views', early);
  // "Not changed since it went live": the project row was just written, so move the publish time up to now.
  await patch(`projects?id=eq.${PID}`, { published_at: new Date().toISOString() });

  let base = process.env.E2E_BASE;
  if (!base) {
    const dir = join(REPO, '_site');
    if (!existsSync(join(dir, 'studio/index.html'))) throw new Error('_site/ not found — run the build + node scripts/assemble-site.mjs first');
    local = await serveSite(dir);
    base = local.base;
  }
  info('testing ' + base);
  const STORAGE_KEY = `sb-${REF}-auth-token`;

  chrome = await launch();
  if (!chrome) throw new Error('Chrome not found (set CHROME_BIN)');
  await chrome.viewport(1280, 900);
  await chrome.goto(base + '/vertly_mark.svg');
  await chrome.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(SESSION))}); true`);
  chrome.consoleMsgs.length = 0;

  const count = (sel) => chrome.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const click = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
  const attr = (sel, a) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`);
  const disabled = (sel) => chrome.eval(`document.querySelector(${JSON.stringify(sel)})?.disabled`);
  const texts = (sel) => chrome.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
  const gotoRetry = async (url) => { try { await chrome.goto(url); } catch { await chrome.goto(url); } };
  const open = async (pid, ready = '[data-testid=biz-body]') => {
    await gotoRetry(base + '/vertly_mark.svg?' + Date.now());
    await gotoRetry(base + `/studio/#/p/${pid}`);
    await chrome.waitFor(`!!document.querySelector('[data-testid=business-stage]')`, 20000);
    await chrome.waitFor(`!!document.querySelector(${JSON.stringify(ready)})`, 20000);
  };
  const dbProject = async (pid = PID) => (await jfetch(`${SB}/rest/v1/projects?id=eq.${pid}&select=stage,published_slug,published_version`, { headers: svc })).json?.[0];
  const publicSite = (slug = SLUG) => jfetch(`https://${username}.vexium.ai/${slug}`);
  const publicWhere = async (ok, ms = 25000) => { const end = Date.now() + ms; let x = await publicSite(); while (!ok(x) && Date.now() < end) { await sleep(1000); x = await publicSite(); } return x; };

  // ── 1. a shop with real numbers ───────────────────────────────────────────────────────────────────────────────
  await open(PID);
  check('BUSINESS: the guided screen is shown (not the "on its way" note)', (await count('[data-testid=business-stage]')) === 1 && !(await text('[data-testid=stage-panel]')).includes('on its way'));
  check('…it is the last step: no "Continue", but a way back to Launch', (await count('[data-testid=stage-continue]')) === 0 && (await count('[data-testid=stage-back]')) === 1);
  check('the address and a Live pill are at the top', (await text('[data-testid=biz-url]')) === `${username}.vexium.ai/${SLUG}` && (await text('[data-testid=biz-live-pill]')) === 'Live', await text('[data-testid=biz-url]'));
  check('enough data (60 visitors, 10 days live): no "early days" banner', (await count('[data-testid=biz-banner]')) === 0 && (await attr('[data-testid=business-stage]', 'data-level')) === 'ok', await attr('[data-testid=business-stage]', 'data-level'));
  const stat = (id) => text(`[data-testid=biz-stat-${id}]`);
  check('visitors = 60', (await stat('visitors')) === '60', await stat('visitors'));
  check('revenue = $40.00 after the refund, 3 orders', (await stat('revenue')) === '$40.00' && (await stat('orders')) === '3', `${await stat('revenue')} ${await stat('orders')}`);
  check('1 sign-up and 1 form entry get their own cards', (await stat('signups')) === '1' && (await stat('leads')) === '1');
  const arrows = await chrome.eval(`[...document.querySelectorAll('[data-testid=biz-stat]')].map((e) => e.dataset.id + ':' + (e.querySelector('[data-testid=biz-change]')?.textContent ?? '-')).join()`);
  check('only visitors has a trend arrow (up, since 25 came before); money and orders have none yet', /visitors:▲ \d+%/.test(arrows) && /revenue:-/.test(arrows) && /orders:-/.test(arrows), arrows);
  check('the chart has one bar target per day for 30 days', (await count('[data-testid=biz-bar]')) === 30, await count('[data-testid=biz-bar]'));
  const total = await chrome.eval(`[...document.querySelectorAll('[data-testid=biz-bar]')].length`);
  await chrome.eval(`document.querySelectorAll('[data-testid=biz-bar]')[${total - 2}].dispatchEvent(new PointerEvent('pointerenter')); true`);
  await sleep(100);
  check('hovering a day shows a tooltip with its count and date', /visitors?/.test((await text('[data-testid=biz-tip]')) ?? ''), await text('[data-testid=biz-tip]'));
  await chrome.eval(`document.querySelector('.chart').dispatchEvent(new PointerEvent('pointerleave')); true`);
  await sleep(100);
  check('…and it goes away again', (await count('[data-testid=biz-tip]')) === 0);
  const sumTable = await chrome.eval(`[...document.querySelectorAll('[data-testid=biz-table] tbody tr')].reduce((n, tr) => n + Number(tr.children[1].textContent.replace(/,/g, '')), 0)`);
  check('the table view lists all 30 days and adds up to ≥ 60 daily visitors', (await count('[data-testid=biz-table] tbody tr')) === 30 && sumTable >= 60, `${await count('[data-testid=biz-table] tbody tr')} rows, ${sumTable}`);
  const sources = await texts('[data-testid=biz-list-sources] .rowbar-name');
  const products = await texts('[data-testid=biz-list-products] .rowbar-name');
  const pages = await texts('[data-testid=biz-list-pages] .rowbar-name');
  check('where visitors come from: Google is listed; the pages and the best seller too', sources.includes('Google') && pages.includes('/') && products[0] === 'Beans', JSON.stringify({ sources, pages, products }));
  const devices = await texts('[data-testid=biz-list-devices] .rowbar-name');
  check('phones and computers are named for people, not as the tracker records them', devices.join() === 'Phone,Computer', devices.join());
  check('the plan is shown next to what happened: 4 rows with the plan\'s own numbers', (await count('[data-testid=biz-plan-row]')) === 4 && (await text('[data-testid=biz-plan-row][data-id=visitors] td')) === '300' && (await text('[data-testid=biz-plan-row][data-id=revenue] td')) === '$120.00', await text('[data-testid=biz-plan]'));
  check('"what stands out": the orders insight is there', (await count('[data-testid=biz-insight][data-id=orders]')) === 1);
  check('recent activity lists the sales, sign-up and form entry', (await count('[data-testid=biz-activity-row]')) >= 4, await count('[data-testid=biz-activity-row]'));
  const all = (await text('[data-testid=business-stage]')) ?? '';
  check('no email address appears anywhere on the screen', !all.includes('@'), all.match(/\S*@\S*/)?.[0] ?? '');
  check('…and Update live site is quiet: nothing changed since it went live', (await count('[data-testid=biz-changed]')) === 0 && (await count('[data-testid=biz-blocked]')) === 0);
  await chrome.screenshot(`${OUT}/business-shop.png`);
  await chrome.viewport(1280, 2600);
  await sleep(300);
  await chrome.screenshot(`${OUT}/business-shop-full.png`);
  await chrome.viewport(1280, 900);

  // period + refresh
  await click('[data-testid=biz-period-7]');
  check('7 days: the numbers and the chart switch', !!(await chrome.waitFor(`document.querySelector('[data-testid=biz-body]')?.dataset.period === '7' && document.querySelectorAll('[data-testid=biz-bar]').length === 7`, 15000)));
  check('…the selected range is marked', (await attr('[data-testid=biz-period-7]', 'aria-pressed')) === 'true' && (await attr('[data-testid=biz-period-30]', 'aria-pressed')) === 'false');
  await click('[data-testid=biz-period-30]');
  await chrome.waitFor(`document.querySelector('[data-testid=biz-body]')?.dataset.period === '30'`, 15000);
  const savedBefore = (await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state&select=version&order=version.desc&limit=1`, { headers: svc })).json?.[0]?.version;
  await click('[data-testid=biz-refresh]');
  await chrome.waitFor(`document.querySelector('[data-testid=biz-refresh]')?.disabled === false && document.querySelector('[data-testid=biz-refresh]')?.textContent === 'Refresh'`, 15000);
  const savedAfter = (await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state&select=version&order=version.desc&limit=1`, { headers: svc })).json?.[0]?.version;
  check('Refresh asks the server to recompute (a new saved business_state version)', savedAfter > savedBefore, `${savedBefore} → ${savedAfter}`);

  // ── 2. a phone ───────────────────────────────────────────────────────────────────────────────────────────────
  await chrome.viewport(390, 800, true);
  await sleep(400);
  const mo = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5 && !e.closest('svg')).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('no horizontal overflow at 390 px', mo.sw <= 390 && mo.wide.length === 0, JSON.stringify(mo));
  await chrome.screenshot(`${OUT}/business-mobile.png`);
  await chrome.viewport(1280, 900);

  // ── 3. a live site nobody has visited / one that is days old ──────────────────────────────────────────────────
  await open(PID_NONE, '[data-testid=biz-banner]');
  check('no visitors yet: says "Waiting for your first visitor" instead of showing zeros as a result', (await text('[data-testid=biz-banner]'))?.includes('Waiting for your first visitor') && (await attr('[data-testid=business-stage]', 'data-level')) === 'none', await text('[data-testid=biz-banner]'));
  check('…no chart is drawn, just a sentence; visitors is the only card; no arrows', (await count('[data-testid=biz-bar]')) === 0 && (await count('[data-testid=biz-chart-empty]')) === 1 && (await count('[data-testid=biz-stat]')) === 1 && (await count('[data-testid=biz-change]')) === 0);
  check('…no plan table and no lists', (await count('[data-testid=biz-plan]')) === 0 && (await count('[data-testid=biz-row]')) === 0);
  await chrome.screenshot(`${OUT}/business-none.png`);
  await open(PID_EARLY, '[data-testid=biz-banner]');
  check('a few visitors: "Early days", the real count, no arrows, a chart', (await text('[data-testid=biz-banner]'))?.includes('Early days') && (await text('[data-testid=biz-stat-visitors]')) === '5' && (await count('[data-testid=biz-change]')) === 0 && (await count('[data-testid=biz-bar]')) === 30, await text('[data-testid=biz-banner]'));
  await chrome.screenshot(`${OUT}/business-early.png`);

  // ── 4. changed since launch, but the final check is not good → Update is closed and says why ─────────────────
  await patch(`projects?id=eq.${PID}`, { files: siteFiles('Bean There — now open late'), published_at: new Date(Date.now() - 3600e3).toISOString() });
  await open(PID);
  check('a draft newer than the live site is announced, and Update live site becomes the main button', (await count('[data-testid=biz-changed]')) === 1 && !(await attr('[data-testid=biz-update]', 'class')).includes('ghost'));
  await chrome.waitFor(`!!document.querySelector('[data-testid=biz-blocked]')`, 15000).catch(() => {});
  check('it is a shop without Stripe: Update live site is closed, with the reason and a way to fix it', (await disabled('[data-testid=biz-update]')) === true && (await text('[data-testid=biz-blocked]'))?.includes('Stripe') && (await count('[data-testid=biz-open-launch]')) === 1, await text('[data-testid=biz-blocked]'));
  await click('[data-testid=biz-open-launch]');
  check('…"Open Launch" moves the project to LAUNCH', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=launch-stage]')`, 15000)) && (await dbProject())?.stage === 'launch', JSON.stringify(await dbProject()));
  await patch(`projects?id=eq.${PID}`, { stage: 'business' });

  // ── 5. Edit site → TWEAKS ────────────────────────────────────────────────────────────────────────────────────
  await open(PID);
  await click('[data-testid=biz-edit]');
  check('Edit site opens TWEAKS (the stage moves, the tweaks screen shows)', !!(await chrome.waitFor(`!!document.querySelector('[data-testid=tweaks-stage]')`, 15000)) && (await dbProject())?.stage === 'tweaks', JSON.stringify(await dbProject()));
  await patch(`projects?id=eq.${PID}`, { stage: 'business' });

  // ── 6. the site stops selling things, the final check is clean → Update live site works ──────────────────────
  await seedChecks([]);
  await patch(`projects?id=eq.${PID}`, { files: siteFiles('Bean There — now open late'), published_at: new Date(Date.now() - 3600e3).toISOString() });
  await open(PID);
  check('with a clean check the button is open', (await disabled('[data-testid=biz-update]')) === false && (await count('[data-testid=biz-blocked]')) === 0, await text('[data-testid=biz-blocked]'));
  await click('[data-testid=biz-update]');
  check('Update live site: shows "Updating…", then "Version 2 is live."', !!(await chrome.waitFor(`document.querySelector('[data-testid=biz-updated]')?.textContent.includes('Version 2')`, 40000)), await text('[data-testid=biz-updated]'));
  const v2 = await publicWhere((x) => x.headers.get('x-vertly-version') === '2');
  check('the public URL serves version 2 with the new headline', v2.headers.get('x-vertly-version') === '2' && v2.text.includes('now open late'), `v${v2.headers.get('x-vertly-version')}`);
  check('…and the "changes not live yet" notice is gone', !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=biz-changed]').length === 0`, 10000)));
  const db = await dbProject();
  check('the database agrees: live version 2, same address', db?.published_version === 2 && db.published_slug === SLUG, JSON.stringify(db));
  await chrome.screenshot(`${OUT}/business-updated.png`);

  // ── 7. taken offline elsewhere → a plain message, no broken screen ──────────────────────────────────────────────
  await patch(`projects?id=eq.${PID_NONE}`, { published_version: null, published_slug: null });
  await open(PID_NONE, '[data-testid=biz-error]');
  check('a site that is not live says so, and offers Launch', (await text('[data-testid=biz-error]'))?.includes('isn’t live yet') && (await text('[data-testid=biz-error]'))?.includes('Go to Launch'), await text('[data-testid=biz-error]'));

  const errs = chrome.consoleMsgs.filter((m) => m.type === 'exception' || (m.type === 'error' && !/favicon|Failed to load resource/i.test(m.text)));
  check('no uncaught exceptions / console errors on the BUSINESS screen', errs.length === 0, JSON.stringify(errs).slice(0, 400));
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  try { if (chrome) await chrome.close(); } catch { /* ignore */ }
  try { if (local) local.server.close(); } catch { /* ignore */ }
  // Update live site published version 2 to R2 (p/<project>/v2/…); best effort — a failure only leaves a few small orphan files.
  try {
    for (const f of ['index.html', 'styles.css', 'site.js']) {
      try { execFileSync('npx', ['--yes', 'wrangler@latest', 'r2', 'object', 'delete', `vertly-sites/p/${PID}/v2/${f}`, '--remote'], { stdio: 'ignore', timeout: 30000 }); } catch { /* not there */ }
    }
  } catch { /* ignore */ }
  for (const pid of [PID, PID_NONE, PID_EARLY]) await jfetch(`${SB}/rest/v1/projects?id=eq.${pid}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/rest/v1/projects?user_id=eq.${uid}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  info('cleanup: throwaway user + projects deleted');
  console.log(`\n${pass} passed, ${fail} failed`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
}

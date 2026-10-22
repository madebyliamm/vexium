#!/usr/bin/env node
// Step 12 "Done when" evidence: idea → live URL, entirely inside the studio — the LAUNCH screen in a real (headless) Chrome against the
// REAL publisher Worker, R2 and database (a throwaway user and project; the stage artifacts are written with the service key, exactly the
// rows the build writes in production, so no model credit is spent).
//
//   (cd studio && npm run build) && node scripts/assemble-site.mjs      # produce _site/
//   node studio/test/launch_e2e.mjs                                     # serves _site/ on localhost and tests that
//   E2E_BASE=https://vexium.ai node studio/test/launch_e2e.mjs          # tests the deployed studio instead
//
// Needs: Google Chrome, the `supabase` CLI logged in (service key), network. Publishes to the real `*.vexium.ai`; deletes the user, the
// project and (best effort, needs `wrangler` logged in) the R2 objects in `finally`. Screenshots: /tmp/studio-e2e/launch-*.png.
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
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-launch-e2e)' };

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
const username = `vxlaunch${rand}`;
const email = `${username}@vexium.ai`;
const password = 'Launch-e2e-' + rand + '!9';
const PID = 'e2e-launch-' + rand;
const NAME = 'Bean There';
const SLUG = `bean-${rand}`;
const siteFiles = (headline) => ({
  'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${NAME}</title><link rel="stylesheet" href="styles.css"></head><body><h1>${headline}</h1><p>Fresh coffee, roasted daily.</p><a href="about.html">About</a><script src="site.js"></script></body></html>`,
  'about.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="styles.css"></head><body><h1>About us</h1><script src="site.js"></script></body></html>`,
  'styles.css': ':root{--accent:#7c3aed}body{font-family:system-ui;color:#111}h1{color:var(--accent)}',
  'site.js': 'window.__site = true;',
  _backend: JSON.stringify({ collections: [], products: [], forms: [], auth: false }),
});

const manifest = (products) => ({ schema: 1, built_at: new Date().toISOString(), pages: [{ file: 'index.html', title: 'Home', in_nav: true }, { file: 'about.html', title: 'About', in_nav: true }], shared_files: ['styles.css', 'site.js'], backend: { collections: [], products, forms: [], auth: false }, cost_cents: 0 });
const check1 = (id, label, status, extra = {}) => ({ id, label, status, ...extra });
const report = (manifestVersion, checks, open = []) => ({ schema: 1, checked_at: new Date().toISOString(), manifest_version: manifestVersion, ok: !checks.some((c) => c.status === 'fail'), checks, open_items: open });

let uid = null, chrome = null, local = null;
try {
  // ── setup: throwaway user + a project that is built and checked, sitting at LAUNCH ──────────────────────────────
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: J, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user failed: ' + r.text);
  uid = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error('sign in failed: ' + r.text);
  const SESSION = r.json;
  const prof = await jfetch(`${SB}/rest/v1/profiles?id=eq.${uid}&select=username`, { headers: svc });
  check('setup: the throwaway user has a profile with its username (the address is <username>.vexium.ai)', prof.json?.[0]?.username === username, prof.text);
  r = await jfetch(SB + '/rest/v1/projects', { method: 'POST', headers: { ...J, Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, user_id: uid, name: NAME, emoji: '☕', files: siteFiles('Bean There'), main_file: 'index.html' }) });
  if (r.status >= 300) throw new Error('create project failed: ' + r.text);

  const rpc = (name, body) => jfetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  const put = async (kind, data) => (await rpc('put_project_artifact', { p_project: PID, p_kind: kind, p_data: data })).json?.version;
  const seedChecks = async (products, checks, open = []) => {
    const mv = await put('manifest', manifest(products));
    await put('launch_checks', report(mv, checks, open));
    return mv;
  };
  const PASS = [check1('pages', 'Every page was built', 'pass'), check1('links', 'Every link goes somewhere', 'pass')];
  await put('plan', { schema: 1, name: NAME, kind: 'site', one_liner: 'x', audience: 'y', offer: 'z', pricing: { model: 'none', items: [] }, pages: [{ file: 'index.html', title: 'Home', purpose: 'p' }], backend: { collections: [], products: [], forms: [], auth: false }, launch_checklist: [], scenario: null });
  await put('style_spec', { schema: 1, locked: true, vibe: { theme: 'light', density: 'comfortable', tone: 'warm' }, tokens: { '--accent': '#7c3aed' }, fonts: { display: 'Fraunces', body: 'Inter' } });
  // A shop with a failed check and no Stripe: blocked twice over.
  await seedChecks(['espresso-beans'], [...PASS, check1('forms', 'Forms are connected', 'fail', { page: 'contact.html', detail: 'The form posts nowhere.' })]);
  r = await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'PATCH', headers: { ...J, Prefer: 'return=minimal' }, body: JSON.stringify({ stage: 'launch' }) });
  if (r.status >= 300) throw new Error('set stage failed: ' + r.text);

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
  const status = () => attr('[data-testid=launch-stage]', 'data-status');
  const statusIs = (want, ms = 15000) => chrome.waitFor(`document.querySelector('[data-testid=launch-stage]')?.dataset.status === ${JSON.stringify(want)}`, ms);
  // A hash-only change never loads a new document, so go through a blank one first (a fresh URL each time) and wait for the screen itself.
  const gotoRetry = async (url) => { try { await chrome.goto(url); } catch { await chrome.goto(url); } };
  const open = async () => { await gotoRetry(base + '/vertly_mark.svg?' + Date.now()); await gotoRetry(base + `/studio/#/p/${PID}`); await chrome.waitFor(`!!document.querySelector('[data-testid=launch-stage]')`, 20000); };
  const setValue = async (sel, value) => {
    await chrome.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(80);
  };
  const live = (path = '') => jfetch(`https://${username}.vexium.ai/${SLUG}${path}`);
  // The publisher caches routes for up to ~10 s per isolate (docs/INFRA.md), so a change reaches the public URL within that.
  const liveWhere = async (ok, ms = 25000) => { const end = Date.now() + ms; let x = await live(); while (!ok(x) && Date.now() < end) { await sleep(1000); x = await live(); } return x; };
  const dbProject = async () => (await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}&select=stage,published_slug,published_version,is_public`, { headers: svc })).json?.[0];

  // ── 1. blocked: a failed check and a shop with no Stripe ──────────────────────────────────────────────────────
  await open();
  check('LAUNCH: the guided screen shows the checklist (not the "on its way" note)', await statusIs('blocked') && (await count('[data-testid=launch-checklist]')) === 1 && !(await text('[data-testid=stage-panel]')).includes('on its way'), await status());
  await chrome.waitFor(`document.querySelector('[data-testid=gate-row][data-id=payments]')?.dataset.state === 'fail'`, 15000).catch(() => {});
  const rows = await chrome.eval(`[...document.querySelectorAll('[data-testid=gate-row]')].map((r) => r.dataset.id + ':' + r.dataset.state).join()`);
  check('checklist: the site has a failed check, payments are not connected, the address is fine', rows === 'site:fail,payments:fail,address:pass', rows);
  check('the failed check is spelled out, open by default', (await text('[data-testid=report-fails]'))?.includes('Forms are connected') && (await chrome.eval(`document.querySelector('[data-testid=launch-report]').open`)) === true, await text('[data-testid=report-fails]'));
  check('"Launch my site" is closed and says why (fix the problem; connect Stripe)', (await disabled('[data-testid=launch-publish]')) === true && (await text('[data-testid=launch-why]'))?.includes('Fix the problem') && (await text('[data-testid=launch-why]'))?.includes('Connect Stripe'), await text('[data-testid=launch-why]'));
  check('a "Connect Stripe" button and a re-check link are offered', (await count('[data-testid=launch-connect-stripe]')) === 1 && (await count('[data-testid=launch-payments-recheck]')) === 1);
  check('"Continue to Business" stays closed while the site is not live', (await disabled('[data-testid=stage-continue]')) === true);
  await chrome.screenshot(`${OUT}/launch-blocked.png`);
  check('nothing was published', (await dbProject())?.published_version === null);

  // ── 2. ready: no shop, a clean report ───────────────────────────────────────────────────────────────────────
  await seedChecks([], PASS, ['Add your opening hours']);
  await open();
  check('a clean report with no shop: ready; the owner\'s to-do is shown but does not block', await statusIs('ready') && (await text('[data-testid=report-open]'))?.includes('opening hours') && (await disabled('[data-testid=launch-publish]')) === false, await status());
  const slugBox = () => chrome.eval(`document.querySelector('[data-testid=launch-slug]').value`);
  check('the address box starts from the project name', (await slugBox()) === 'bean-there', await slugBox());
  await setValue('[data-testid=launch-slug]', 'Bean There ');
  check('typing is tidied (lowercase, hyphens, no stray characters)', (await slugBox()) === 'bean-there-', await slugBox());
  check('…an address ending in a hyphen is refused with a reason, and the button closes', (await disabled('[data-testid=launch-publish]')) === true && (await text('[data-testid=launch-why]'))?.includes('hyphen'), await text('[data-testid=launch-why]'));
  await setValue('[data-testid=launch-slug]', SLUG);
  check('a good address opens the button again', (await disabled('[data-testid=launch-publish]')) === false);
  await chrome.screenshot(`${OUT}/launch-ready.png`);

  // ── 3. launch for real ──────────────────────────────────────────────────────────────────────────────────────
  await click('[data-testid=launch-publish]');
  check('Launch: the button shows progress while the site goes online', !!(await chrome.waitFor(`document.querySelector('[data-testid=launch-stage]')?.dataset.status === 'publishing' || !!document.querySelector('[data-testid=launch-live]')`, 8000)));
  check('Launch: the screen becomes the live card', await statusIs('live', 40000) && (await count('[data-testid=launch-live]')) === 1, await status());
  check('…it celebrates ("You\'re live!", confetti, the version number)', (await text('[data-testid=launch-headline]'))?.includes("You're live") && (await count('[data-testid=launch-confetti]')) === 1 && (await text('[data-testid=launch-launched]'))?.includes('Version 1'), await text('[data-testid=launch-headline]'));
  check('…the live address is shown and links to it', (await text('[data-testid=launch-url]')) === `${username}.vexium.ai/${SLUG}` && (await attr('[data-testid=launch-url]', 'href')) === `https://${username}.vexium.ai/${SLUG}`, await text('[data-testid=launch-url]'));
  check('…there is a scannable QR code for it', (await chrome.eval(`(() => { const p = document.querySelector('[data-testid=launch-qr] path'); return !!p && p.getAttribute('d').length > 200 && document.querySelector('[data-testid=launch-qr] svg').getAttribute('aria-label').includes(${JSON.stringify(SLUG)}); })()`)) === true);
  const db1 = await dbProject();
  check('the database says it is live: version 1, the chosen address, public', db1?.published_version === 1 && db1.published_slug === SLUG && db1.is_public === true, JSON.stringify(db1));
  const home = await liveWhere((x) => x.status === 200);
  check('the public URL serves the site (HTTP 200, x-vertly-version: 1, the headline)', home.status === 200 && home.headers.get('x-vertly-version') === '1' && home.text.includes('<h1>Bean There</h1>'), `${home.status} v${home.headers.get('x-vertly-version')}`);
  const about = await live('/about.html');
  check('…and its other page too', about.status === 200 && about.text.includes('About us'), about.status);
  check('…private files stay private (_backend is not served)', (await live('/_backend')).status === 404);
  check('the "reachable" pill settles on Live', !!(await chrome.waitFor(`document.querySelector('[data-testid=launch-reach]')?.dataset.reach === 'yes'`, 20000)), await attr('[data-testid=launch-reach]', 'data-reach'));
  check('"Continue to Business" is open now that the site is live', (await disabled('[data-testid=stage-continue]')) === false);
  check('no draft-changed notice yet', (await count('[data-testid=launch-changed]')) === 0);
  await chrome.screenshot(`${OUT}/launch-live.png`);

  // reload: the live card (without the party) comes back from the database
  await open();
  check('after a reload it is still live, without the confetti', await statusIs('live') && (await count('[data-testid=launch-confetti]')) === 0 && (await text('[data-testid=launch-headline]')) === 'Your site is live', await status());

  // ── 4. update, go back ──────────────────────────────────────────────────────────────────────────────────────
  r = await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'PATCH', headers: { ...J, Prefer: 'return=minimal' }, body: JSON.stringify({ files: siteFiles('Bean There — now open late'), published_at: new Date(Date.now() - 3600e3).toISOString() }) });
  check('setup: the draft changes after the publish', r.status < 300, r.text);
  await open();
  check('a draft that is newer than the live site says so, and "Update live site" becomes the main button', await statusIs('live-changes') && (await count('[data-testid=launch-changed]')) === 1, await status());
  await click('[data-testid=launch-update]');
  check('Update: a new version goes live', !!(await chrome.waitFor(`document.querySelector('[data-testid=launch-live]') && !document.querySelector('[data-testid=launch-update]').disabled && document.querySelector('[data-testid=launch-launched]')?.textContent.includes('Version 2')`, 40000)), await text('[data-testid=launch-launched]'));
  const v2 = await liveWhere((x) => x.headers.get('x-vertly-version') === '2');
  check('…the public URL now serves version 2 with the new headline', v2.headers.get('x-vertly-version') === '2' && v2.text.includes('now open late'), `v${v2.headers.get('x-vertly-version')}`);
  check('…the earlier versions are listed, the live one marked', !!(await chrome.waitFor(`document.querySelectorAll('[data-testid=deploy-row]').length === 2`, 8000)) && (await attr('[data-testid=deploy-row]', 'data-live')) === 'true');
  await chrome.eval(`document.querySelector('[data-testid=launch-versions]').open = true; true`);
  await click('[data-testid=deploy-back-1]');
  check('Go back to version 1: the live site is the old one again', !!(await chrome.waitFor(`document.querySelector('[data-testid=deploy-row][data-live=true] .version-line')?.textContent.startsWith('Version 1')`, 20000)));
  const back = await liveWhere((x) => x.headers.get('x-vertly-version') === '1');
  check('…public URL serves version 1 (headline back to the old one)', back.headers.get('x-vertly-version') === '1' && back.text.includes('<h1>Bean There</h1>'), `v${back.headers.get('x-vertly-version')}`);

  // ── 5. a phone ──────────────────────────────────────────────────────────────────────────────────────────────
  await chrome.viewport(390, 800, true);
  await sleep(400);
  const mo = await chrome.eval(`(() => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => e.tagName + '.' + e.className).slice(0, 5) }))()`);
  check('the live card has no horizontal overflow at 390px', mo.sw <= 390 && mo.wide.length === 0, JSON.stringify(mo));
  await chrome.screenshot(`${OUT}/launch-mobile.png`);
  await chrome.viewport(1280, 900);

  // ── 6. take it offline ──────────────────────────────────────────────────────────────────────────────────────
  await click('[data-testid=launch-offline]');
  check('Take offline asks first, and says the work is kept', (await count('[data-testid=launch-offline-confirm]')) === 1 && (await text('[data-testid=launch-offline-confirm]'))?.includes('Your work is kept'));
  await click('[data-testid=launch-offline-yes]');
  check('…then the screen goes back to the launch checklist', await statusIs('ready', 25000), await status());
  const db2 = await dbProject();
  check('the database says it is offline, and the visitors get a 404', db2?.published_version === null && db2.published_slug === null && (await liveWhere((x) => x.status === 404)).status === 404, JSON.stringify(db2));
  check('"Continue to Business" is closed again', !!(await chrome.waitFor(`document.querySelector('[data-testid=stage-continue]')?.disabled === true`, 8000)));
  // Offline sites forget their address (a new page load starts from the project name again), so choose it again.
  await setValue('[data-testid=launch-slug]', SLUG);
  await click('[data-testid=launch-publish]');
  const relaunched = await statusIs('live', 40000);
  const again = await liveWhere((x) => x.status === 200);
  check('launching again brings the site back (a new version)', relaunched && again.status === 200, `${await status()} public=${again.status} ${JSON.stringify(await dbProject())}`);

  const errs = chrome.consoleMsgs.filter((m) => m.type === 'exception' || (m.type === 'error' && !/favicon|Failed to load resource/i.test(m.text)));
  check('no uncaught exceptions / console errors on the LAUNCH screen', errs.length === 0, JSON.stringify(errs).slice(0, 400));
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  try { if (chrome) await chrome.close(); } catch { /* ignore */ }
  try { if (local) local.server.close(); } catch { /* ignore */ }
  // The published objects live in R2 (p/<project>/v<n>/…); best effort — a failure here only leaves a few small orphan files.
  try {
    for (const v of [1, 2, 3]) for (const f of ['index.html', 'about.html', 'styles.css', 'site.js']) {
      try { execFileSync('npx', ['--yes', 'wrangler@latest', 'r2', 'object', 'delete', `vertly-sites/p/${PID}/v${v}/${f}`, '--remote'], { stdio: 'ignore', timeout: 30000 }); } catch { /* not there */ }
    }
  } catch { /* ignore */ }
  await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/rest/v1/projects?user_id=eq.${uid}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  info('cleanup: throwaway user + project deleted');
  console.log(`\n${pass} passed, ${fail} failed`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
}

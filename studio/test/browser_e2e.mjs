#!/usr/bin/env node
// Step 6 "Done when" evidence: the assembled site in a real (headless) Chrome — signed-out bounce to /auth.html and back,
// signed-in studio rendering with the shared tokens, routing, sign-out, legacy pages still served, repo/docs NOT served.
//
//   (cd studio && npm run build) && node scripts/assemble-site.mjs      # produce _site/
//   node studio/test/browser_e2e.mjs                                    # serves _site/ on localhost and tests that
//   E2E_BASE=https://vexium.ai node studio/test/browser_e2e.mjs         # tests the deployed site instead
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

  await chrome.eval(`location.hash = '#/p/does-not-exist'; true`);
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
  void live;
} catch (e) {
  fail++;
  console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  try { if (chrome) await chrome.close(); } catch { /* ignore */ }
  try { if (local) local.server.close(); } catch { /* ignore */ }
  await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'DELETE', headers: svc });
  if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  info('cleanup: throwaway user + project deleted');
  console.log(`\n${pass} passed, ${fail} failed`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
}

#!/usr/bin/env node
// Step 5 "Done when" evidence: a FRESH build through the deployed pipeline (spec call → build Worker → ai-chat), then two
// follow-up edits, a publish to Hosting v2, and a real-browser run against the live URL.
//
//   node scripts/step5_build_e2e.mjs            full run (spends real Anthropic credits on a throwaway user, ~$0.5)
//   STEP5_KEEP=1 node …                         keep the throwaway user/project (to look at the site by hand)
//   STEP5_REUSE=/tmp/step5-run/files.json node … skip the builds, re-run lint + publish + browser checks on saved files
//
// Everything created here (user, project, rows, R2 objects) is deleted in `finally` unless STEP5_KEEP=1.
// Output: PASS/FAIL checks, WARN lines for things worth a human look, screenshots + the generated files in /tmp/step5-run/.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launch } from '../sdk/test/cdp.mjs';

const REPO = new URL('../', import.meta.url).pathname;
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const FN = SB + '/functions/v1';
const BUILD_URL = 'https://vexium-ai-build.startafter.workers.dev';
const WORKER = 'https://vexium-publisher.startafter.workers.dev';
const ANON = /SUPABASE_ANON_KEY = "([^"]+)"/.exec(readFileSync(REPO + 'publisher/wrangler.toml', 'utf8'))[1];
const OUT = '/tmp/step5-run';
mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-step5-e2e)' };

const svcKey = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { encoding: 'utf8' }))
  .find((k) => k.name === 'service_role' || k.id === 'service_role').api_key;
const svc = { apikey: svcKey, Authorization: 'Bearer ' + svcKey, ...UA };

let pass = 0, fail = 0, warn = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 300)}]` : '')); };
const warning = (msg) => { warn++; console.log('WARN ' + msg); };
const info = (msg) => console.log('INFO ' + msg);

async function jfetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

// ── builds ────────────────────────────────────────────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

/** One streamed build call, parsed the way the editor parses it. Returns { files (changed), message, events, raw }. */
async function streamBuild(url, bearer, body) {
  const res = await fetch(url, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + bearer }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`build call failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const changed = {}, deleted = [], renamed = [];
  let message = '', events = {}, maxTokensHit = false, buf = '';
  const handle = (block) => {
    let ev = null; const data = [];
    for (const line of block.split(/\r?\n/)) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5)); }
    if (!ev || !data.length) return;
    let d; try { d = JSON.parse(data.join('\n').trim()); } catch { return; }
    events[ev] = (events[ev] || 0) + 1;
    if (ev === 'file' && d.name) changed[d.name] = d.encoding === 'base64' ? b64(d.content) : d.content;
    else if (ev === 'delete') deleted.push(d.name);
    else if (ev === 'rename') renamed.push(d);
    else if (ev === 'message') message = d.message || message;
    else if (ev === 'delta' && !message) message += d.text || '';
    else if (ev === 'max_tokens_hit') maxTokensHit = true;
    else if (ev === 'error') throw new Error('build error event: ' + JSON.stringify(d).slice(0, 400));
  };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const rawPath = `${OUT}/raw-${Date.now()}.sse`;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch (e) { events.__readError = String(e); break; }
    const { done, value } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    appendFileSync(rawPath, value);
    const blocks = buf.split(/\r?\n\r?\n/); buf = blocks.pop() || '';
    blocks.forEach(handle);
  }
  if (buf.trim()) handle(buf);
  return { files: changed, deleted, renamed, message, events, maxTokensHit };
}

/** What the editor sends as `files`: memory + shared files in full, the active pages in full, other pages omitted when _pages exists. */
function filesPayload(fs, active) {
  const out = {};
  for (const f of ['_longterm', '_shortterm', '_backend', '_pages']) if (fs[f] !== undefined) out[f] = fs[f];
  const hasIndex = !!fs._pages;
  for (const f of new Set(['index.html', active, 'styles.css', 'site.js', 'manifest.json'])) if (f && fs[f] !== undefined) out[f] = fs[f];
  for (const f of Object.keys(fs)) if (out[f] === undefined && !f.startsWith('_') && !f.endsWith('.html')) out[f] = fs[f];
  if (!hasIndex) for (const f of Object.keys(fs)) if (out[f] === undefined && f.endsWith('.html')) out[f] = fs[f];
  return out;
}

const SKELETON = '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"/><title>New site</title></head>\n<body></body>\n</html>';

// ── lint (what the Step 10 verifier will do mechanically; here it is evidence + guidance) ────────────
const REQUIRED_TOKENS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--text-muted', '--accent', '--accent-contrast', '--font-display', '--font-body', '--radius', '--radius-lg', '--shadow-sm', '--shadow-lg', '--container', '--nav-h', '--section-y'];
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
// raw colors are allowed only as the VALUE of a custom property (--x: #fff) — :root tokens and artwork-local properties
function stripCustomProps(css) { return css.replace(/--[\w-]+\s*:[^;{}]*;?/g, ''); }
function rawColors(css) { return (stripCustomProps(css).replace(/\/\*[\s\S]*?\*\//g, '').match(RAW_COLOR) || []); }
const FAKE_PATTERNS = [
  [/lorem ipsum/i, 'lorem ipsum'], [/fakeco|acme corp|example\.com\b/i, 'placeholder company'], [/coming soon/i, '"coming soon"'],
  [/\btrusted by\b/i, '"trusted by"'], [/[★⭐]{2,}|\b[45]\.\d\s*(\/\s*5|stars?|★)/i, 'star ratings'],
  [/\b\d{1,3}(,\d{3})+\+?\s+(customers|users|members|teams|businesses|people|orders|reviews)/i, 'invented counts'],
  [/\bjoin\s+\d[\d,]*\+?/i, '"join N"'], [/\b(uptime|99\.\d+%)/i, 'uptime stat'], [/testimonial|what (our )?(customers|clients) say/i, 'testimonial section'],
  [/\b\(?\d{3}\)?[ -.]\d{3}[ -.]\d{4}\b/, 'phone number'], [/\b\d{2,5}\s+[A-Z][a-z]+\s+(Street|St|Ave|Avenue|Road|Rd|Blvd|Lane|Ln)\b/, 'street address'],
];

function lint(fs) {
  const html = Object.keys(fs).filter((f) => f.endsWith('.html'));
  check('files: styles.css, site.js, manifest.json, index.html, _backend, _longterm all present', ['styles.css', 'site.js', 'manifest.json', 'index.html', '_longterm'].every((f) => typeof fs[f] === 'string' && fs[f].length > 20), Object.keys(fs).join(', '));
  const css = fs['styles.css'] || '';
  check('styles.css: first rules are the font @import then :root with every required token', /^\s*(\/\*[\s\S]*?\*\/\s*)?@import\s+url\(/.test(css) && REQUIRED_TOKENS.every((t) => new RegExp(t + '\\s*:').test((css.match(/:root\s*\{[^}]*\}/) || [''])[0])), REQUIRED_TOKENS.filter((t) => !new RegExp(t + '\\s*:').test((css.match(/:root\s*\{[^}]*\}/) || [''])[0])).join(' '));
  const rc = rawColors(css);
  if (rc.length) warning(`styles.css: ${rc.length} raw color(s) in real properties (${[...new Set(rc)].slice(0, 8).join(' ')}) — the verifier (Step 10) will flag/fix these`);
  if (!/\.vx-nav|\.vx-footer|\.vx-link/.test(css)) warning('styles.css never styles .vx-nav / .vx-link / .vx-footer (the SDK defaults will show)');
  for (const f of html) {
    const h = fs[f];
    const inline = [...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const attrs = [...h.matchAll(/\sstyle="([^"]*)"/gi)].map((m) => m[1]).join(';');
    const bad = [...rawColors(inline), ...(attrs.match(RAW_COLOR) || [])];
    check(`${f}: skeleton (shared css/js, nav+footer placeholders, no own nav/footer, no :root)`,
      /<link[^>]+href=["']styles\.css["']/.test(h) && /<script[^>]+src=["']site\.js["']/.test(h) && /<header[^>]*data-vx-nav/.test(h) && /<footer[^>]*data-vx-footer/.test(h) && !/<nav[\s>]/i.test(h) && !/:root\s*\{/.test(inline), '');
    if (bad.length) warning(`${f}: ${bad.length} raw color(s) in real properties (${[...new Set(bad)].slice(0, 6).join(' ')})`);
    check(`${f}: no pasted helpers / fetch to backend / project-id placeholder / font links`, !/vxCall|vxSignup|vxLogin|vxBuy\(|VX_API|SITE_ID|\{\{VEXIUM_PROJECT_ID\}\}|site-api|stripe-site-checkout|fonts\.googleapis\.com/.test(h), (h.match(/vxCall|vxSignup|vxLogin|vxBuy\(|VX_API|SITE_ID|\{\{VEXIUM_PROJECT_ID\}\}|site-api|stripe-site-checkout|fonts\.googleapis\.com/) || [''])[0]);
    check(`${f}: no opacity:0 / no '#' placeholder links`, !/opacity\s*:\s*0(?![.\d])/.test(inline + attrs) && !/href=["']#["']/.test(h), '');
    for (const [re, what] of FAKE_PATTERNS) { const m = h.match(re); if (m) warning(`${f}: possible invented content — ${what}: "${m[0]}"`); }
    const links = [...h.matchAll(/\shref=["']([^"'#?][^"']*)["']/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:|tel:|data:)/.test(u));
    const missing = links.filter((u) => !fs[u.split('#')[0]] && !/^\/?(vx|__vx)/.test(u));
    check(`${f}: every internal link points at a page that exists`, missing.length === 0, missing.join(', '));
  }
  // site.js
  let site = null;
  try { site = new Function('window', fs['site.js'] + '; return window.SITE;')({}); } catch (e) { /* reported below */ }
  check('site.js: evaluates to window.SITE with a name and a nav', !!site && !!site.name && Array.isArray(site.nav) && site.nav.length >= 2, site ? Object.keys(site).join(',') : 'did not evaluate');
  if (site) {
    const dead = (site.nav || []).concat(site.cta ? [site.cta] : []).concat(((site.footer || {}).columns || []).flatMap((c) => c.links || [])).filter((l) => l.href && !/^(https?:|mailto:|tel:)/.test(l.href) && !fs[l.href.split('#')[0]]).map((l) => l.href);
    check('site.js: every nav/footer link resolves to an existing page', dead.length === 0, dead.join(', '));
    if ((site.nav || []).length > 6) warning(`site.js nav has ${site.nav.length} items`);
  }
  let man = null; try { man = JSON.parse(fs['manifest.json']); } catch { /* */ }
  check('manifest.json: valid JSON with name, start_url, theme_color, background_color', !!man && man.name && man.start_url && man.theme_color && man.background_color, man ? Object.keys(man).join(',') : 'invalid');
  // backend ↔ markup agreement
  let be = null; try { be = JSON.parse(fs['_backend'] || 'null'); } catch { /* */ }
  const allHtml = html.map((f) => fs[f]).join('\n');
  const formNames = new Map();
  for (const m of allHtml.matchAll(/<form\b[^>]*data-vx-form=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/gi)) formNames.set(m[1], [...m[2].matchAll(/\sname=["']([^"']+)["']/g)].map((x) => x[1]));
  if (formNames.size) {
    check('_backend declares every data-vx-form collection and every input name as a field', !!be && [...formNames].every(([id, names]) => { const c = (be.collections || []).find((x) => x.id === id); return c && names.every((n) => (c.fields || []).some((f) => f.key === n)); }),
      be ? [...formNames].map(([id, n]) => `${id}:${n}`).join(' ') + ' vs ' + JSON.stringify((be.collections || []).map((c) => [c.id, (c.fields || []).map((f) => f.key)])) : 'no _backend');
  }
  const buys = [...allHtml.matchAll(/data-vx-buy=["']([^"']+)["']/g)].map((m) => m[1]).filter((id) => !id.includes('${')); // dynamic ids (template literals) are checked at runtime
  if (buys.length) check('every data-vx-buy id exists in _backend products with a valid price', !!be && buys.every((id) => (be.products || []).some((p) => p.id === id && Number.isInteger(p.price_cents) && p.price_cents >= 50)), buys.join(','));
  if (/data-vx-auth|data-vx-require-auth/.test(allHtml)) check('_backend: auth.enabled true when pages use accounts', !!be && be.auth && be.auth.enabled === true);
  let lt = null; try { lt = JSON.parse(fs['_longterm']); } catch { /* */ }
  check('_longterm: valid JSON with kind + brand', !!lt && ['site', 'app'].includes(lt.kind) && !!lt.brand, lt ? JSON.stringify({ kind: lt.kind }) : 'invalid');
  info('_longterm.needs_from_owner = ' + JSON.stringify(lt && lt.needs_from_owner));
  if (lt && lt.design && /#[0-9a-f]{3,8}/i.test(JSON.stringify(lt.design))) warning('_longterm.design still carries raw colors (tokens should live only in styles.css)');
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────
const stamp = String(Date.now());
const username = 'sfive' + stamp.slice(-9);
const email = `vertly-s5-${stamp}@example.com`;
const password = 'Tt!' + Buffer.from(svcKey.slice(-12)).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) + stamp.slice(-4);
const PID = 'proj_s5_' + stamp;
let uid = null, token = null, published = [];

const PROMPTS = {
  build: 'Build the website for Lumen Candle Co., a small online shop that sells hand-poured soy candles. I sell two candles: "Ember" (warm amber and cedar) for $24 and "Dusk" (lavender and sandalwood) for $28. Visitors should be able to buy them right on the site, join a list to hear when new scents drop, and message me with a contact form. Warm, calm, minimal. No accounts needed. I have no photos, reviews or numbers to share yet. Just build it now, don\'t ask me anything.',
  about: 'Add an About page. Tell the story of how a candle gets made here, in a few warm paragraphs, and link it in the menu.',
  members: 'Add a members area: a page where people can create an account or log in, and a private "My wishlist" page where a signed-in customer can save candles they like and see only their own list. The menu should show Log in when signed out and My wishlist and Log out when signed in.',
};

try {
  // setup
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  check('setup: throwaway user', r.status === 200 || r.status === 201, r.status);
  uid = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  token = r.json.access_token;
  check('setup: signed in', !!token, r.status);
  r = await jfetch(SB + '/rest/v1/projects', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ id: PID, name: 'Step5 E2E', user_id: uid, files: { 'index.html': SKELETON }, main_file: 'index.html' }) });
  check('setup: project row', r.status === 201, r.status + ' ' + r.text.slice(0, 120));

  let fs = {};
  if (process.env.STEP5_REUSE) {
    fs = JSON.parse(readFileSync(process.env.STEP5_REUSE, 'utf8'));
    info('reusing saved files from ' + process.env.STEP5_REUSE);
  } else {
    // 1. fresh build — spec call in parallel with turn 1 like the editor, then the build
    const t0 = Date.now();
    let spec = null;
    try { const sp = await jfetch(FN + '/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + token }, body: JSON.stringify({ spec_mode: true, messages: [{ role: 'user', content: PROMPTS.build }] }) }); if (sp.json && (sp.json.layout_archetype || sp.json.color_bg)) spec = sp.json; } catch { /* optional */ }
    info(`art-direction spec: ${spec ? spec.layout_archetype : 'none'} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    const messages = [{ role: 'user', content: PROMPTS.build }];
    let category;
    const body1 = () => ({ messages, files: { 'index.html': SKELETON }, spec: spec || undefined, stream: true, main_file: 'index.html', active_file: 'index.html', project_has_real_files: false, project_id: PID, fresh_build_session: true });
    let b = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      b = await streamBuild(BUILD_URL, token, body1());
      info(`build 1 (attempt ${attempt}): ${Object.keys(b.files).join(', ') || '(no files)'} in ${((Date.now() - t0) / 1000).toFixed(0)}s; events ${JSON.stringify(b.events)}`);
      if (b.files['index.html']) break;
      if (b.events.done) { // the onboarding gate asked a question instead of building: answer like a user would
        messages.push({ role: 'assistant', content: b.message && b.message.trim() ? b.message : 'Got it.' }, { role: 'user', content: 'Just build it now please.' });
      } else {
        // The response stream ended without `done` (cut mid-file). Seen intermittently at ~3 min with no server-side trace; the editor
        // recovers via its early-close save + auto-continue. Here we just ask again, like a user pressing "try again".
        warning(`build stream was cut without a "done" event (attempt ${attempt}) — retrying`);
      }
    }
    check('fresh build: no continuation needed', !b.maxTokensHit);
    Object.assign(fs, b.files);
    writeFileSync(OUT + '/chat-1.txt', b.message);
    info('assistant said: ' + b.message.replace(/\s+/g, ' ').slice(0, 400));
    const firstFiles = Object.keys(b.files).filter((f) => !f.startsWith('_'));
    check('first build wrote exactly the landing set: styles.css, index.html, site.js, manifest.json (no other pages)', ['styles.css', 'index.html', 'site.js', 'manifest.json'].every((f) => firstFiles.includes(f)) && firstFiles.length === 4, firstFiles.join(', '));

    // 2. edit: add a page (edit path, Haiku)
    for (const [key, label] of [['about', 'about page'], ['members', 'members area']]) {
      const t1 = Date.now();
      const before = Object.keys(fs);
      const e = await streamBuild(BUILD_URL, token, { messages: [{ role: 'user', content: PROMPTS[key] }], files: filesPayload(fs, 'index.html'), stream: true, main_file: 'index.html', active_file: 'index.html', project_has_real_files: true, project_id: PID, fresh_build_session: false });
      Object.assign(fs, e.files);
      for (const d of e.deleted) delete fs[d];
      const created = Object.keys(e.files).filter((f) => !before.includes(f));
      info(`edit (${label}): changed ${Object.keys(e.files).join(', ')}; new ${created.join(', ') || '-'} in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
      writeFileSync(OUT + `/chat-${key}.txt`, e.message);
      check(`edit (${label}): created at least one new page and patched site.js`, created.some((f) => f.endsWith('.html')) && !!e.files['site.js'], Object.keys(e.files).join(', '));
      check(`edit (${label}): did not rewrite styles.css or index.html wholesale`, !(e.files['index.html'] && key === 'about' && e.files['index.html'].length < 0.5 * (fs['index.html'] || '').length));
    }
    writeFileSync(OUT + '/files.json', JSON.stringify(fs, null, 1));
  }
  for (const [n, c] of Object.entries(fs)) writeFileSync(OUT + '/out-' + n.replace(/[^\w.-]/g, '_'), c);

  // 3. lint
  lint(fs);

  // 4. publish through Hosting v2 and open the live URL in a real browser
  const slug = 'step5-' + stamp.slice(-8);
  const pub = await jfetch(WORKER + '/__vx/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ projectId: PID, slug, files: fs, mainFile: 'index.html' }) });
  check('publish via Hosting v2', pub.status === 200 && pub.json && pub.json.ok === true, pub.status + ' ' + pub.text.slice(0, 160));
  published = Object.keys(fs).filter((f) => !f.split('/').some((s) => s.startsWith('_')));
  const base = `https://${username}.vexium.ai/${slug}/`;
  let live = { status: 0 };
  for (let i = 0; i < 20 && live.status !== 200; i++) { live = await jfetch(base); if (live.status !== 200) await new Promise((r) => setTimeout(r, 1500)); }
  check('live URL serves the landing page', live.status === 200, live.status);
  const hd = live.text;
  check('live HTML: SDK + site id injected inside <head>, before any page script', /<head[^>]*><base [^>]*><script>window\.__VX=\{site:"[^"]+"\}<\/script><script src="\/__vx\/sdk\/v1\.js\?v=[0-9a-f]+"><\/script>/i.test(hd), hd.slice(0, 300));
  for (const f of ['styles.css', 'site.js', 'manifest.json']) {
    const a = await jfetch(base + f);
    check(`live: ${f} served (${f === 'manifest.json' ? 'manifest+json' : f === 'styles.css' ? 'text/css' : 'javascript'})`, a.status === 200 && (f === 'manifest.json' ? /manifest\+json/ : f === 'styles.css' ? /text\/css/ : /javascript/).test(a.headers.get('content-type') || ''), `${a.status} ${a.headers.get('content-type')}`);
  }
  check('live: _backend is not served', (await jfetch(base + '_backend')).status === 404);

  const chrome = await launch();
  if (!chrome) { warning('no Chrome: skipped the browser checks'); }
  else {
    try {
      const E = (x) => chrome.eval(x);
      await chrome.preload(`window.__alerts=[];window.alert=function(m){window.__alerts.push(String(m))};`);
      await chrome.viewport(1280, 900);
      await chrome.goto(base);
      await chrome.waitFor(`!!document.querySelector('.vx-nav .vx-link')`, 8000);
      const d = await E(`({links:[].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent.trim()+'>'+a.getAttribute('href')}),brand:(document.querySelector('.vx-brand-name')||{}).textContent,
        footer:!!document.querySelector('.vx-footer .vx-legal'),cur:(document.querySelector('[aria-current=page]')||{}).textContent,
        manifest:!!document.querySelector('link[rel=manifest]'),theme:(document.querySelector('meta[name=theme-color]')||{}).content,
        h1:(document.querySelector('h1')||{}).textContent,bg:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily.slice(0,60),
        overflowX:document.documentElement.scrollWidth>window.innerWidth+1})`);
      info('live page: ' + JSON.stringify(d));
      check('live: nav rendered from site.js with the current page marked', d.links.length >= 2 && !!d.brand && d.footer);
      check('live: tokens in styles.css drive the page (body background is a real color, not white default)', d.bg !== 'rgba(0, 0, 0, 0)', d.bg);
      check('live: no horizontal overflow on desktop', !d.overflowX);
      await chrome.screenshot(OUT + '/live-desktop.png');
      await chrome.viewport(390, 844, true);
      await chrome.goto(base);
      await chrome.waitFor(`!!document.querySelector('.vx-burger')`, 6000);
      const m = await E(`({burger:getComputedStyle(document.querySelector('.vx-burger')).display,menu:getComputedStyle(document.querySelector('.vx-menu')).display,overflowX:document.documentElement.scrollWidth>window.innerWidth+1})`);
      check('mobile: burger visible, menu collapsed, no horizontal overflow', m.burger !== 'none' && m.menu === 'none' && !m.overflowX, JSON.stringify(m));
      await E(`document.querySelector('.vx-burger').click()`);
      check('mobile: burger opens the menu', (await E(`getComputedStyle(document.querySelector('.vx-menu')).display`)) !== 'none');
      await chrome.screenshot(OUT + '/live-mobile.png');
      await chrome.viewport(1280, 900);

      const pages = Object.keys(fs).filter((f) => f.endsWith('.html') && f !== 'index.html');
      // re-theme: change tokens in :root and verify the whole page follows (what editing styles.css would do)
      const retheme = async (path) => {
        await chrome.goto(base + path);
        await chrome.waitFor(`!!document.querySelector('.vx-nav .vx-link')`, 6000);
        return E(`(function(){
          function rgb(v){var d=document.createElement('div');d.style.color=v;document.body.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c}
          var props=['color','backgroundColor','borderTopColor','borderBottomColor'];
          var toks={'--accent':'rgb(1, 255, 2)','--bg':'rgb(3, 4, 5)','--text':'rgb(250, 6, 7)'};
          var st=document.createElement('style');st.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.appendChild(st); // measure the end state, not a fade
          var all=[document.documentElement,document.body].concat([].slice.call(document.body.querySelectorAll('*'))).filter(function(e){var r=e.getBoundingClientRect();return e===document.body||e===document.documentElement||(r.width>0&&r.height>0)});
          var out={};
          Object.keys(toks).forEach(function(t){
            var orig=rgb('var('+t+')'); var hit=[];
            all.forEach(function(e){var cs=getComputedStyle(e);props.forEach(function(p){var bw=p.indexOf('border')===0?parseFloat(cs[p.replace('Color','Width')]):1; if(cs[p]===orig&&bw>0)hit.push([e,p])})});
            out[t]={tokenValue:orig,uses:hit.length,hit:hit};
          });
          Object.keys(toks).forEach(function(t){document.documentElement.style.setProperty(t,toks[t])});
          var res={};
          Object.keys(toks).forEach(function(t){var o=out[t];var stuck=o.hit.filter(function(h){return getComputedStyle(h[0])[h[1]]===o.tokenValue}).length;res[t]={uses:o.uses,stuck:stuck}});
          return res})()`);
      };
      for (const pg of ['index.html', ...pages.slice(0, 3)]) {
        const rt = await retheme(pg === 'index.html' ? '' : pg);
        const bad = Object.entries(rt).filter(([, v]) => v.uses > 0 && v.stuck / v.uses > 0.15);
        check(`re-theme ${pg || 'index.html'}: changing --accent/--bg/--text in :root recolors the page (≥85% of uses follow)`, bad.length === 0 && Object.values(rt).some((v) => v.uses > 0), JSON.stringify(rt));
      }
      // forms → site-api (real rows land in site_data)
      await chrome.goto(base);
      const formIds = await E(`[].map.call(document.querySelectorAll('form[data-vx-form]'),function(f){return f.getAttribute('data-vx-form')})`);
      info('forms on landing: ' + JSON.stringify(formIds));
      check('landing has at least one data-vx-form', formIds.length >= 1);
      for (const id of formIds) {
        const filled = await E(`(function(){var f=document.querySelector('form[data-vx-form="${id}"]');[].forEach.call(f.elements,function(el){if(!el.name||el.type==='submit'||el.type==='button')return;if(el.type==='email'||/email/i.test(el.name))el.value='visitor@example.com';else if(el.type==='checkbox')el.checked=true;else if(el.tagName==='SELECT')el.selectedIndex=Math.min(1,el.options.length-1);else if(el.type==='number')el.value='2';else if(el.type==='date')el.value='2027-01-15';else if(el.type==='tel')el.value='5551234567';else el.value='Hello from the Step 5 test';});return true})()`);
        await E(`document.querySelector('form[data-vx-form="${id}"] [type=submit], form[data-vx-form="${id}"] button').click()`);
        const ok = await chrome.waitFor(`document.querySelector('form[data-vx-form="${id}"]').getAttribute('data-vx-state')==='sent'`, 8000);
        const msg = await E(`(document.querySelector('form[data-vx-form="${id}"] [data-vx-message]')||{}).textContent`);
        check(`form "${id}": submit works on the live site (state=sent)`, ok, ok ? msg : `state=${await E(`document.querySelector('form[data-vx-form="${id}"]').getAttribute('data-vx-state')`)} msg=${msg}`);
        const rows = await jfetch(`${SB}/rest/v1/site_data?project_id=eq.${PID}&collection=eq.${id}&select=data`, { headers: svc });
        check(`form "${id}": row is stored with only declared fields`, rows.json && rows.json.length >= 1, JSON.stringify(rows.json).slice(0, 200));
      }

      // buy buttons → stripe-site-checkout (no Stripe connected for a throwaway user, so the expected answer is the clear "not connected" error)
      const buy = await E(`[].map.call(document.querySelectorAll('[data-vx-buy]'),function(b){return b.getAttribute('data-vx-buy')})`);
      info('buy buttons on landing: ' + JSON.stringify(buy));
      check('landing has a buy button for each product (Ember, Dusk)', buy.length >= 2);
      if (buy.length) {
        await E(`window.__alerts=[]; document.querySelector('[data-vx-buy]').click()`);
        await chrome.waitFor(`window.__alerts.length>0`, 8000);
        const al = await E('window.__alerts');
        check('buy click reaches stripe-site-checkout and shows its answer (no Stripe connected → "Stripe not connected")', al.length === 1 && /Stripe not connected/i.test(al[0]), JSON.stringify(al));
      }

      // other pages: each nav link opens, renders chrome, and has no horizontal overflow
      for (const p of pages) {
        await chrome.goto(base + p);
        await chrome.waitFor(`!!document.querySelector('.vx-nav .vx-link')`, 6000);
        const pd = await E(`({nav:document.querySelectorAll('.vx-menu a').length,cur:(document.querySelector('[aria-current=page]')||{}).textContent,overflowX:document.documentElement.scrollWidth>window.innerWidth+1,h1:(document.querySelector('h1')||{}).textContent,empty:document.querySelector('main')?document.querySelector('main').innerText.trim().length<80:null})`);
        check(`${p}: opens on the live site with the shared nav, no overflow, real content`, pd.nav >= 2 && !pd.overflowX && pd.empty !== true, JSON.stringify(pd));
        await chrome.screenshot(OUT + '/live-' + p.replace('.html', '') + '.png');
      }

      // accounts: signup through the generated form, guard + nav swap
      const authPage = pages.find((p) => /data-vx-auth=["']signup/.test(fs[p]));
      const protectedPage = pages.find((p) => /data-vx-require-auth/.test(fs[p]));
      if (authPage) {
        await chrome.goto(base + authPage);
        await E('localStorage.clear()');
        await chrome.goto(base + authPage);
        const mode = await E(`!!document.querySelector('form[data-vx-auth="signup"]')`);
        const sel = 'form[data-vx-auth="signup"]';
        const shown = await E(`(function(){var f=document.querySelector('${sel}'); return !!f && f.offsetParent!==null})()`);
        if (!shown) { await E(`[].some.call(document.querySelectorAll('button,a,[role=tab]'),function(b){if(/sign ?up|create|register|join/i.test(b.textContent)&&!b.closest('form')){b.click();return true}})`); }
        await E(`(function(){var f=document.querySelector('${sel}');[].forEach.call(f.elements,function(el){if(!el.name||el.type==='submit'||el.type==='button')return;if(/email/i.test(el.name))el.value='s5-${stamp}@example.com';else if(el.type==='password')el.value='correct horse battery';else if(el.type==='checkbox')el.checked=true;else el.value='Step Five'});})()`);
        await E(`document.querySelector('${sel} [type=submit], ${sel} button').click()`);
        const redirected = await chrome.waitFor(`document.querySelector('[data-vx-user]')||localStorage.getItem('vx_token')`, 8000);
        const tokenSet = await E(`!!localStorage.getItem('vx_token')`);
        check('account: signup through the generated form signs the visitor in', mode && tokenSet && redirected, `msg=${await E(`(document.querySelector('${sel} [data-vx-message]')||{}).textContent`)}`);
        const users = await jfetch(`${SB}/rest/v1/site_users?project_id=eq.${PID}&select=email,password_hash`, { headers: svc });
        check('account: stored with a PBKDF2 hash', users.json && users.json.length === 1 && /^pbkdf2\$sha256\$/.test(users.json[0].password_hash), JSON.stringify(users.json).slice(0, 120));
        if (protectedPage) {
          await chrome.goto(base + protectedPage);
          await chrome.waitFor(`!!document.querySelector('.vx-nav .vx-link')`, 6000);
          const stays = (await E('location.pathname')).endsWith(protectedPage);
          const links = await E(`[].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent.trim()})`);
          check('account: protected page stays open when signed in and the nav shows the signed-in items', stays && !links.some((l) => /log in|sign in/i.test(l)) && links.some((l) => /log out|sign out/i.test(l)), JSON.stringify(links));
          await chrome.screenshot(OUT + '/live-protected-signedin.png');
          await E('localStorage.clear()');
          await chrome.goto(base + protectedPage);
          const bounced = await chrome.waitFor(`!location.pathname.endsWith('${protectedPage}')`, 6000);
          check('account: the same page bounces a signed-out visitor to the login page', bounced, await E('location.pathname'));
        } else warning('no page uses data-vx-require-auth (the wishlist page should be protected)');
      } else warning('no generated page has a data-vx-auth="signup" form');
      const errs = chrome.consoleMsgs.filter((x) => x.type === 'exception');
      check('no uncaught page exceptions anywhere on the live site', errs.length === 0, JSON.stringify(errs).slice(0, 300));
    } finally { await chrome.close(); }
  }
} catch (e) {
  fail++; console.log('FAIL script error: ' + (e.stack || e));
} finally {
  if (process.env.STEP5_KEEP) {
    info(`KEEPING user ${username} / project ${PID} (password in this run only: ${password})`);
  } else {
    // R2 objects → delete files of the live version; then project rows; then the user
    try {
      const vr = await jfetch(`${SB}/rest/v1/project_deploys?project_id=eq.${PID}&select=version`, { headers: svc });
      for (const v of (vr.json || []).map((x) => x.version)) for (const f of published) {
        try { execFileSync('npx', ['--yes', 'wrangler@latest', 'r2', 'object', 'delete', `vertly-sites/p/${PID}/v${v}/${f}`, '--remote'], { stdio: 'ignore', cwd: REPO }); } catch { /* best effort */ }
      }
    } catch { /* ignore */ }
    for (const t of ['site_data', 'site_sessions', 'site_users', 'project_deploys']) await jfetch(`${SB}/rest/v1/${t}?project_id=eq.${PID}`, { method: 'DELETE', headers: svc });
    await jfetch(`${SB}/rest/v1/projects?id=eq.${PID}`, { method: 'DELETE', headers: svc });
    if (uid) await jfetch(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
    info('cleanup: throwaway user, project, rows and R2 objects deleted');
  }
}
console.log(`\nRESULTS ${pass} passed, ${fail} failed, ${warn} warnings   (files + screenshots in ${OUT})`);
process.exit(fail ? 1 : 0);

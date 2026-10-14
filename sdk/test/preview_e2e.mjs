// Runs the REAL preview code from editor.html and viewer.html (functions extracted with the TypeScript parser, not copies)
// against a sample v2 project in headless Chrome, as a blob: document inside an iframe — exactly how both previews run sites.
//   node sdk/test/preview_e2e.mjs        (needs Google Chrome; SKIPs cleanly without it)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';
import { FETCH_STUB, launch } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), 'utf8');

/** Pull top-level `function name(...) {...}` / `const name = …;` source text out of a page's inline <script>s. */
function extract(htmlFile, names) {
  const html = read(htmlFile);
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const found = {};
  for (const code of scripts) {
    const sf = ts.createSourceFile('x.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)) found[n.name.text] = n.getText(sf);
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && names.includes(d.name.text)) found[d.name.text] = n.getText(sf);
    });
  }
  const missing = names.filter((n) => !found[n]);
  assert.deepEqual(missing, [], `could not extract from ${htmlFile}: ${missing}`);
  return names.map((n) => found[n]).join('\n');
}

const SDK = read('sdk/v1.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// A tiny v2 project, written the way the AI is told to write it (docs/PROJECT_FORMAT.md).
const page = (title, body, htmlAttr = '', extraHead = '') => `<!DOCTYPE html>
<html lang="en"${htmlAttr}>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${title}</title>
<link rel="stylesheet" href="styles.css"/>${extraHead}</head>
<body><header data-vx-nav></header><main>${body}</main><footer data-vx-footer></footer><script src="site.js"></script></body></html>`;
const PROJECT = {
  'styles.css': ':root{--bg:#102030;--text:#eeeeee;--accent:#ff6600;--nav-h:60px}body{background:var(--bg);color:var(--text);margin:0}.hero{padding:40px}',
  'site.js': 'window.SITE = { name: "Acme", logo: "logo.png", nav: [ {label:"Home",href:"index.html"}, {label:"Pricing",href:"pricing.html"}, {label:"Log in",href:"login.html",show:"out"}, {label:"Dashboard",href:"dashboard.html",show:"in"} ], footer:{ legal:"© Acme" } };',
  'logo.png': PNG,
  'index.html': page('Home', '<section class="hero" id="top">HOME PAGE</section><form id="wl" data-vx-form="waitlist"><input name="email" value="a@b.co"/><button type="submit">Join</button><p data-vx-message></p></form>'),
  'pricing.html': page('Pricing', '<section class="hero">PRICING PAGE</section>'),
  'login.html': page('Login', '<section class="hero">LOGIN PAGE</section>', ' data-vx-skip-if-auth="dashboard.html"'),
  'dashboard.html': page('Dashboard', '<section class="hero">DASHBOARD PAGE</section>', ' data-vx-require-auth="login.html"'),
};

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/sdk/v1.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); return res.end(SDK); }
  if (path === '/editor-host.html' || path === '/viewer-host.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(hosts[path]); }
  res.writeHead(404); res.end('nope');
});

// ── hosts: the real functions + the minimum globals they use ────────────────────────────────────
const isImg = `function isImageFile(fn){return /\\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(fn)}`;
const edFns = extract('editor.html', ['VX_SDK_URL', 'buildPageHtml', 'refreshPreviewPage']);
const viewFns = extract('viewer.html', ['escRe', 'VX_SDK_URL', 'buildPageHtml', 'renderPage']);
const PROJECT_JSON = JSON.stringify(PROJECT).replace(/<\//g, '<\\/'); // survive being embedded in an inline <script>
const hosts = {
  '/editor-host.html': `<!DOCTYPE html><html><body><iframe id="previewFrame" style="width:1000px;height:700px"></iframe><script>
    var fileSystem = ${PROJECT_JSON}; var projectId = 'proj_prev'; var mainFile = 'index.html'; var prevHistory = [], prevHistIdx = -1;
    ${isImg}
    function normalizeMainFile(m){return m} function setUrl(){} function pushHist(){} function updateNavBtns(){}
    ${edFns}
    refreshPreviewPage('index.html');
  <\/script></body></html>`,
  '/viewer-host.html': `<!DOCTYPE html><html><body><iframe id="frame" style="width:1000px;height:700px"></iframe><script>
    var fileSystem = ${PROJECT_JSON}; history.replaceState(null,'','/viewer-host.html?project=proj_prev');
    ${viewFns}
    renderPage('index.html');
  <\/script></body></html>`,
};

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const chrome = await launch();
if (!chrome) { console.log('SKIP no Google Chrome found'); server.close(); process.exit(0); }
await chrome.preload(FETCH_STUB);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
}

async function suite(label, hostPath, frameId) {
  const inner = (expr) => chrome.eval(`(function(){var w=document.getElementById('${frameId}').contentWindow;return (new w.Function(${JSON.stringify(expr)}))()})()`); // runs with the IFRAME as its global scope
  const open = async () => { await chrome.goto(ORIGIN + hostPath); await chrome.eval('localStorage.clear()'); await chrome.goto(ORIGIN + hostPath); await chrome.waitFor(`!!document.getElementById('${frameId}').contentDocument.querySelector('.vx-nav')`, 8000); };
  const title = () => inner('return document.title');

  await t(`${label}: SDK loads in the preview, nav + footer render from site.js, styles.css applied, logo resolved`, async () => {
    await open();
    const r = await inner(`var d=document;return {title:d.title,sdk:!!window.vx,site:window.__VX&&window.__VX.site,page:window.__VX&&window.__VX.page,
      links:[].map.call(d.querySelectorAll('.vx-menu a'),function(a){return a.textContent}),current:(d.querySelector('[aria-current=page]')||{}).textContent,
      bodyBg:getComputedStyle(d.body).backgroundColor,logo:(d.querySelector('.vx-logo')||{}).src||'',legal:(d.querySelector('.vx-legal')||{}).textContent,
      cssLink:!!d.querySelector('link[href="styles.css"]'),scriptSrc:!!d.querySelector('script[src="site.js"]')}`);
    assert.equal(r.title, 'Home'); assert.equal(r.sdk, true); assert.equal(r.site, 'proj_prev'); assert.equal(r.page, 'index.html');
    assert.deepEqual(r.links, ['Home', 'Pricing', 'Log in']);
    assert.equal(r.current, 'Home');
    assert.equal(r.bodyBg, 'rgb(16, 32, 48)');
    assert.ok(r.logo.startsWith('data:image/png;base64,'), 'logo not inlined: ' + r.logo.slice(0, 40));
    assert.equal(r.legal, '© Acme');
    assert.equal(r.cssLink, false); assert.equal(r.scriptSrc, false); // inlined by the previewer
  });

  await t(`${label}: clicking a nav link (JS-rendered) opens that page in the preview`, async () => {
    await open();
    await inner(`document.querySelector('.vx-menu a[href="pricing.html"]').click()`);
    assert.ok(await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.title==='Pricing'`, 6000), 'still on: ' + await title());
    assert.equal(await inner('return document.querySelector("[aria-current=page]").textContent'), 'Pricing');
  });

  await t(`${label}: auth guard on a protected page bounces to the login page inside the preview`, async () => {
    await open();
    await inner(`document.querySelector('.vx-menu a[href="login.html"]'); window.location.hash='vexnav=dashboard.html'`); // visit the protected page
    assert.ok(await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.title==='Login'`, 8000), 'guard did not bounce, now: ' + await title());
  });

  await t(`${label}: signing in swaps the nav, and the signed-in guard moves login → dashboard`, async () => {
    await open();
    await inner(`window.location.hash='vexnav=login.html'`);
    await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.title==='Login'`, 6000);
    await inner(`localStorage.setItem('vx_token','vxs_tok');localStorage.setItem('vx_user',JSON.stringify({id:'u1',email:'a@b.co'}));window.dispatchEvent(new StorageEvent('storage',{key:'vx_token'}))`);
    // storage events don't fire in the same window; reload the login page like a real return visit
    await inner(`window.location.hash='vexnav=index.html'`);
    await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.title==='Home'`, 6000);
    await inner(`window.location.hash='vexnav=login.html'`);
    assert.ok(await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.title==='Dashboard'`, 8000), 'signed-in user not moved off login, now: ' + await title());
    const links = await inner(`return [].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent})`);
    assert.deepEqual(links, ['Home', 'Pricing', 'Dashboard']);
  });

  await t(`${label}: [data-vx-form] posts to site-api with the project id the previewer injected`, async () => {
    await open();
    await inner(`document.querySelector('#wl button').click()`);
    await chrome.waitFor(`document.getElementById('${frameId}').contentDocument.getElementById('wl').getAttribute('data-vx-state')==='sent'`, 5000);
    const call = await inner('return window.__calls[0]');
    assert.equal(call.url.split('/').pop(), 'site-api');
    assert.deepEqual(call.body, { project_id: 'proj_prev', action: 'submit', collection: 'waitlist', data: { email: 'a@b.co' } });
  });
}

try {
  await chrome.viewport(1280);
  await suite('editor preview', '/editor-host.html', 'previewFrame');
  await suite('viewer.html', '/viewer-host.html', 'frame');
  await t('no uncaught exceptions in the page or the SDK', () => assert.deepEqual(chrome.consoleMsgs.filter((m) => m.type === 'exception'), []));
} finally {
  await chrome.close();
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

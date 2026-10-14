// Real-browser tests for the SDK's chrome (nav/footer) + declarative hooks + guards.
//   node sdk/test/browser_e2e.mjs            (needs Google Chrome; exits 0 with a SKIP line when it is not installed)
// A local server serves test pages + the repo's sdk/v1.js; window.fetch is stubbed so no network is touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { FETCH_STUB, launch } from './cdp.mjs';

const SDK = readFileSync(new URL('../v1.js', import.meta.url), 'utf8');

const SITE_JS = `window.SITE = {
  name: 'Acme <b>Co</b>',
  nav: [
    { label: 'Home', href: 'index.html' },
    { label: 'Features', href: 'index.html#features' },
    { label: 'Pricing', href: 'pricing.html' },
    { label: 'Evil', href: 'javascript:alert(1)' },
    { label: 'Docs', href: 'https://example.com/docs' },
    { label: 'Log in', href: 'login.html', show: 'out' },
    { label: 'Dashboard', href: 'dashboard.html', show: 'in' },
    { label: 'Log out', action: 'logout', show: 'in' }
  ],
  cta: { label: 'Get started', href: 'signup.html', show: 'out' },
  footer: { tagline: 'Makes <things>.', columns: [{ title: 'Company', links: [{ label: 'About', href: 'about.html' }] }], social: [{ label: 'Instagram', href: 'https://instagram.com/acme' }], legal: '© {year} Acme' }
};`;

const pages = {
  '/index.html': (extra = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script><style>:root{--bg:#fafafa;--nav-h:68px}section{height:1500px}</style></head>
<body><header data-vx-nav></header><main><section id="hero">hero</section><section id="features">features</section></main><footer data-vx-footer></footer>
<span id="who" data-vx-user="name"></span><div id="in" data-vx-show="in">in!</div><div id="out" data-vx-show="out">out!</div>
<script src="/site.js"></script>${extra}</body></html>`,
  '/pricing.html': () => `<!DOCTYPE html><html><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body><header data-vx-nav></header><script src="/site.js"></script></body></html>`,
  '/shop/index.html': () => `<!DOCTYPE html><html><head><base href="/shop/"><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script><style>section{height:1500px}</style></head><body><header data-vx-nav></header><section id="a">a</section><section id="features">features</section><script src="/site.js"></script></body></html>`,
  '/contact.html': () => `<!DOCTYPE html><html><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body>
<form id="f" data-vx-form="waitlist" data-vx-success="You're on the list."><input name="email"/><input type="checkbox" name="news" checked/><button type="submit">Go</button><p data-vx-message></p></form></body></html>`,
  '/signup.html': () => `<!DOCTYPE html><html data-vx-skip-if-auth="dashboard.html"><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body>
<form id="s" data-vx-auth="signup" data-vx-redirect="dashboard.html"><input name="name" value="Ada"/><input name="email" value="ada@x.co"/><input name="password" type="password" value="longenough1"/><input name="confirm" type="password" value="longenough1"/><button type="submit">Create</button><p data-vx-message></p></form>
<form id="l" data-vx-auth="login"><input name="email" value="ada@x.co"/><input name="password" type="password" value="bad"/><button type="submit">In</button><p data-vx-message></p></form></body></html>`,
  '/dashboard.html': () => `<!DOCTYPE html><html data-vx-require-auth="login.html"><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body><h1>Dash</h1><span id="u" data-vx-user="email"></span><button id="lo" data-vx-logout data-vx-redirect="index.html">Out</button></body></html>`,
  '/login.html': () => `<!DOCTYPE html><html><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body>login page</body></html>`,
  '/store.html': () => `<!DOCTYPE html><html><head><script>window.__VX={site:'proj_test'}</script><script src="/sdk/v1.js"></script></head><body>
<button id="b1" data-vx-buy="tee-classic">Buy</button><button id="b2" data-vx-buy-amount="500" data-vx-name="Donation">Give</button><div id="ok" data-vx-paid hidden>Paid!</div></body></html>`,
  '/paid-stub.html': () => '<!DOCTYPE html><html><body>stripe</body></html>',
  '/previewed.html': () => `<!DOCTYPE html><html data-vx-require-auth="login.html"><head><script>window.__NAV=[];window.__VX={site:'proj_test',page:'dashboard.html',navigate:function(u){window.__NAV.push(u)}}</script><script src="/sdk/v1.js"></script></head><body>
<form id="s" data-vx-auth="login" data-vx-redirect="dashboard.html"><input name="email" value="a@b.co"/><input name="password" value="longenough1"/><button type="submit">In</button></form></body></html>`,
};

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/sdk/v1.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(SDK); }
  if (path === '/site.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(SITE_JS); }
  if (path === '/shop/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages['/shop/index.html']()); }
  if (path === '/shop/site.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(SITE_JS); }
  const p = pages[path] || (path === '/' ? pages['/index.html'] : null);
  if (!p) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(p());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const chrome = await launch();
if (!chrome) { console.log('SKIP no Google Chrome found'); server.close(); process.exit(0); }
await chrome.preload(FETCH_STUB);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await chrome.goto(ORIGIN + '/login.html'); await chrome.eval('localStorage.clear()'); await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
}
const session = (extra = {}) => ({ json: { success: true, token: 'vxs_tok', expires_at: new Date(Date.now() + 864e5).toISOString(), user: { id: 'u1', email: 'ada@x.co', metadata: { name: 'Ada' } }, ...extra } });
const E = (x) => chrome.eval(x);

try {
  await chrome.viewport(1280);

  await t('nav: renders links, marks the current page, escapes text, drops javascript: hrefs, opens external links safely', async () => {
    await chrome.goto(ORIGIN + '/pricing.html');
    const r = await E(`(function(){var n=document.querySelector('[data-vx-nav]');return {cls:n.className,
      links:[].map.call(n.querySelectorAll('.vx-menu a'),function(a){return a.textContent+'|'+a.getAttribute('href')+'|'+(a.getAttribute('aria-current')||'')+'|'+(a.target||'')}),
      brand:n.querySelector('.vx-brand-name').textContent, injected:n.querySelectorAll('b').length}})()`);
    assert.equal(r.cls, 'vx-nav');
    assert.equal(r.brand, 'Acme <b>Co</b>');           // shown as text…
    assert.equal(r.injected, 0);                         // …never parsed as HTML
    assert.deepEqual(r.links, [
      'Home|index.html||', 'Features|index.html#features||', 'Pricing|pricing.html|page|', 'Evil|#||',
      'Docs|https://example.com/docs||_blank', 'Log in|login.html||', 'Get started|signup.html||',
    ]);
    assert.ok(await E(`document.querySelector('a[href="https://example.com/docs"]').rel.includes('noopener')`));
  });

  await t('logo: images may be data:image URLs, but javascript:/data:text URLs are dropped', async () => {
    await chrome.goto(ORIGIN + '/pricing.html');
    const r = await E(`(function(){var h=window.vx.site.navHtml;return [
      h({name:'A',logo:'data:image/png;base64,AAAA'},null,'x'), h({name:'A',logo:'data:text/html,<script>1</script>'},null,'x'), h({name:'A',logo:'javascript:alert(1)'},null,'x'), h({name:'A',logo:'logo.png',logoOnly:true},null,'x')].map(function(x){var m=/<img class="vx-logo" src="([^"]*)" alt="([^"]*)"/.exec(x);return m?[m[1],m[2],x.indexOf('vx-brand-name')>-1]:null})})()`);
    assert.deepEqual(r, [['data:image/png;base64,AAAA', '', true], ['#', '', true], ['#', '', true], ['logo.png', 'A', false]]);
  });

  await t('footer: columns, tagline escaped, external social opens in a new tab', async () => {
    await chrome.goto(ORIGIN + '/');
    const r = await E(`(function(){var f=document.querySelector('[data-vx-footer]');return {cls:f.className,title:f.querySelector('.vx-footer-title').textContent,
      tag:f.querySelector('.vx-footer-tagline').textContent,tagHtml:f.querySelectorAll('things').length,legal:f.querySelector('.vx-legal').textContent,
      ig:f.querySelector('.vx-social a').target}})()`);
    assert.deepEqual(r, { cls: 'vx-footer', title: 'Company', tag: 'Makes <things>.', tagHtml: 0, legal: '© ' + new Date().getFullYear() + ' Acme', ig: '_blank' });
  });

  await t('SDK base CSS is the first thing in <head>; manifest link + theme-color are added when SITE exists', async () => {
    await chrome.goto(ORIGIN + '/');
    const r = await E(`({first:document.head.firstElementChild.hasAttribute('data-vx-base'),manifest:!!document.querySelector('link[rel=manifest][href="manifest.json"]'),theme:(document.querySelector('meta[name=theme-color]')||{}).content})`);
    assert.deepEqual(r, { first: true, manifest: true, theme: '#fafafa' });
  });

  await t('auth-aware nav + [data-vx-show] + [data-vx-user]: signed out → signed in → signed out', async () => {
    await chrome.goto(ORIGIN + '/');
    const out = await E(`({nav:[].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent}),inHidden:document.getElementById('in').hidden,outHidden:document.getElementById('out').hidden,who:document.getElementById('who').textContent})`);
    assert.ok(out.nav.includes('Log in') && !out.nav.includes('Dashboard') && !out.nav.includes('Log out'));
    assert.equal(out.inHidden, true); assert.equal(out.outHidden, false); assert.equal(out.who, '');
    await E(`window.__reply=function(){return ${JSON.stringify(session())}}; vx.auth.login('ada@x.co','pw-long-enough').then(function(){})`);
    await chrome.waitFor(`!document.getElementById('in').hidden`);
    const inn = await E(`({nav:[].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent}),outHidden:document.getElementById('out').hidden,who:document.getElementById('who').textContent})`);
    assert.ok(inn.nav.includes('Dashboard') && inn.nav.includes('Log out') && !inn.nav.includes('Log in') && !inn.nav.includes('Get started'), JSON.stringify(inn.nav));
    assert.equal(inn.outHidden, true); assert.equal(inn.who, 'Ada');
    await E(`window.__reply=function(){return {json:{success:true}}}; document.querySelector('[data-vx-logout]').click()`);
    await chrome.waitFor(`document.getElementById('in').hidden`);
    assert.ok((await E(`[].map.call(document.querySelectorAll('.vx-menu a'),function(a){return a.textContent}).includes('Log in')`)));
  });

  await t('mobile: burger shows, menu opens/closes (button, link click, Escape)', async () => {
    await chrome.viewport(390, 800, true);
    await chrome.goto(ORIGIN + '/');
    const vis = (sel) => E(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return !!e&&getComputedStyle(e).display!=='none'})()`);
    assert.equal(await vis('.vx-burger'), true);
    assert.equal(await vis('.vx-menu'), false);
    await E(`document.querySelector('.vx-burger').click()`);
    assert.equal(await vis('.vx-menu'), true);
    assert.equal(await E(`document.querySelector('.vx-burger').getAttribute('aria-expanded')`), 'true');
    await E(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    assert.equal(await vis('.vx-menu'), false);
    await E(`document.querySelector('.vx-burger').click()`);
    await E(`document.querySelector('.vx-menu a[href="index.html#features"]').click()`);
    assert.equal(await vis('.vx-menu'), false);
    await chrome.viewport(1280);
    assert.equal(await vis('.vx-burger'), false);
  });

  await t('anchor links scroll in place — including "index.html#x" on the home page and under <base href="/shop/">', async () => {
    await chrome.goto(ORIGIN + '/');
    await E(`document.querySelector('.vx-menu a[href="index.html#features"]').click()`);
    assert.ok(await chrome.waitFor(`window.scrollY > 800`), 'did not scroll');
    assert.ok((await E('location.pathname')) === '/' || (await E('location.pathname')) === '/index.html');
    assert.equal(await E('location.hash'), '#features');
    await chrome.goto(ORIGIN + '/shop/');
    await E(`document.querySelector('.vx-menu a[href="index.html#features"]').click()`);
    assert.ok(await chrome.waitFor(`window.scrollY > 800`), 'did not scroll under <base>');
    assert.equal(await E('location.pathname'), '/shop/');
  });

  await t('a malformed anchor like href="#100%" does not throw', async () => {
    await chrome.goto(ORIGIN + '/');
    await E(`(function(){var a=document.createElement('a');a.href='#50%';a.textContent='x';document.body.appendChild(a);a.click()})()`);
    assert.deepEqual(chrome.consoleMsgs.filter((m) => m.type === 'exception'), []);
  });

  await t('[data-vx-form]: submits named fields to the collection, shows the message, resets', async () => {
    await chrome.goto(ORIGIN + '/contact.html');
    await E(`document.querySelector('[name=email]').value='a@b.co'; document.querySelector('#f button').click()`);
    await chrome.waitFor(`document.getElementById('f').getAttribute('data-vx-state')==='sent'`);
    const r = await E(`({calls:window.__calls.map(function(c){return c.body}),msg:document.querySelector('[data-vx-message]').textContent,email:document.querySelector('[name=email]').value})`);
    assert.deepEqual(r.calls[0], { project_id: 'proj_test', action: 'submit', collection: 'waitlist', data: { email: 'a@b.co', news: true } });
    assert.equal(r.msg, "You're on the list.");
    assert.equal(r.email, '');
  });

  await t('[data-vx-form]: server error is shown on the form', async () => {
    await chrome.goto(ORIGIN + '/contact.html');
    await E(`window.__reply=function(){return {status:429,json:{error:'Too many requests'}}}; document.querySelector('#f button').click()`);
    await chrome.waitFor(`document.getElementById('f').getAttribute('data-vx-state')==='error'`);
    assert.equal(await E(`document.querySelector('[data-vx-message]').textContent`), 'Too many requests');
  });

  await t('[data-vx-auth=signup]: extra fields become metadata, confirm is checked, success redirects', async () => {
    await chrome.goto(ORIGIN + '/signup.html');
    await E(`window.__reply=function(){return ${JSON.stringify(session())}}; document.querySelector('#s button').click()`);
    assert.ok(await chrome.waitFor(`location.pathname==='/dashboard.html'`), 'no redirect');
    // (the first call is the signup; the dashboard page then reloads with the stub fresh)
  });
  await t('[data-vx-auth=signup]: records metadata + rejects mismatched confirm', async () => {
    await chrome.goto(ORIGIN + '/signup.html');
    await E(`document.querySelector('#s [name=confirm]').value='different'; document.querySelector('#s button').click()`);
    assert.equal(await E(`document.querySelector('#s [data-vx-message]').textContent`), "Passwords don't match.");
    assert.equal(await E(`window.__calls.length`), 0);
    await E(`document.querySelector('#s [name=confirm]').value='longenough1'; window.__reply=function(){return {status:409,json:{error:'That email already has an account'}}}; document.querySelector('#s button').click()`);
    await chrome.waitFor(`document.querySelector('#s').getAttribute('data-vx-state')==='error'`);
    const c = await E(`window.__calls[0].body`);
    assert.deepEqual(c, { project_id: 'proj_test', action: 'signup', email: 'ada@x.co', password: 'longenough1', metadata: { name: 'Ada' } });
    assert.equal(await E(`document.querySelector('#s [data-vx-message]').textContent`), 'That email already has an account');
  });
  await t('[data-vx-auth=login]: wrong password shows the server error, no redirect', async () => {
    await chrome.goto(ORIGIN + '/signup.html');
    await E(`window.__reply=function(){return {status:401,json:{error:'Wrong email or password'}}}; document.querySelector('#l button').click()`);
    await chrome.waitFor(`document.querySelector('#l').getAttribute('data-vx-state')==='error'`);
    assert.equal(await E(`document.querySelector('#l [data-vx-message]').textContent`), 'Wrong email or password');
    assert.equal(await E('location.pathname'), '/signup.html');
  });

  await t('guards: require-auth bounces signed-out visitors; skip-if-auth bounces signed-in; no loops', async () => {
    await chrome.goto(ORIGIN + '/login.html');
    await E(`localStorage.clear()`);
    await chrome.goto(ORIGIN + '/dashboard.html');
    assert.ok(await chrome.waitFor(`location.pathname==='/login.html'`), 'signed-out visitor not bounced');
    await E(`localStorage.setItem('vx_token','vxs_tok');localStorage.setItem('vx_user',JSON.stringify({id:'u1',email:'ada@x.co'}))`);
    await chrome.goto(ORIGIN + '/dashboard.html');
    assert.equal(await E('location.pathname'), '/dashboard.html');
    assert.equal(await E(`document.getElementById('u').textContent`), 'ada@x.co');
    await chrome.goto(ORIGIN + '/signup.html');
    assert.ok(await chrome.waitFor(`location.pathname==='/dashboard.html'`), 'signed-in user not bounced off signup');
  });

  await t('logout on a protected page signs out and redirects', async () => {
    await E(`localStorage.setItem('vx_token','vxs_tok');localStorage.setItem('vx_user',JSON.stringify({id:'u1',email:'ada@x.co'}))`);
    await chrome.goto(ORIGIN + '/dashboard.html');
    await E(`document.getElementById('lo').click()`);
    assert.ok(await chrome.waitFor(`location.pathname==='/index.html' || location.pathname==='/login.html'`), 'no redirect after logout');
    assert.equal(await E(`localStorage.getItem('vx_token')`), null);
  });

  await t('[data-vx-buy] / [data-vx-buy-amount] start checkout; [data-vx-paid] appears on ?paid=1', async () => {
    await chrome.goto(ORIGIN + '/store.html');
    assert.equal(await E(`document.getElementById('ok').hidden`), true);
    await E(`window.__reply=function(){return {json:{url:'/paid-stub.html'}}}; document.getElementById('b1').click()`);
    assert.ok(await chrome.waitFor(`location.pathname==='/paid-stub.html'`), 'buy did not redirect');
    await chrome.goto(ORIGIN + '/store.html');
    await E(`window.__reply=function(){return {json:{url:'/paid-stub.html'}}}; document.getElementById('b2').click()`);
    await chrome.waitFor(`location.pathname==='/paid-stub.html'`);
    await chrome.goto(ORIGIN + '/store.html?paid=1');
    assert.equal(await E(`document.getElementById('ok').hidden`), false);
  });
  await t('[data-vx-buy] sends product_id / amount to stripe-site-checkout', async () => {
    await chrome.goto(ORIGIN + '/store.html');
    await E(`window.__reply=function(){return {json:{error:'nope'}}}; window.alert=function(){}; document.getElementById('b1').click()`);
    await chrome.waitFor(`window.__calls.length===1`);
    await E(`document.getElementById('b2').click()`);
    await chrome.waitFor(`window.__calls.length===2`);
    const c = await E(`window.__calls.map(function(c){return {url:c.url.split('/').pop(),pid:c.body.product_id,amt:c.body.amount_cents,name:c.body.name,site:c.body.project_id}})`);
    assert.deepEqual(c, [
      { url: 'stripe-site-checkout', pid: 'tee-classic', site: 'proj_test' },
      { url: 'stripe-site-checkout', amt: 500, name: 'Donation', site: 'proj_test' },
    ]);
  });

  await t('previewer hook: guards, redirects and vx.go use window.__VX.navigate instead of location', async () => {
    await chrome.goto(ORIGIN + '/previewed.html');
    assert.deepEqual(await E('window.__NAV'), ['login.html']);        // signed-out guard asked the previewer to navigate
    assert.equal(await E('location.pathname'), '/previewed.html');     // …and the document itself did not move
    await E(`window.__reply=function(){return ${JSON.stringify(session())}}; document.querySelector('#s button').click()`);
    await chrome.waitFor(`window.__NAV.length>=2`);
    assert.ok((await E('window.__NAV')).includes('dashboard.html'));
    await E(`vx.go('pricing.html')`);
    assert.equal((await E('window.__NAV')).at(-1), 'pricing.html');
    assert.equal(await E('location.pathname'), '/previewed.html');
  });

  const errs = chrome.consoleMsgs.filter((m) => m.type === 'exception');
  await t('no uncaught exceptions anywhere', () => assert.deepEqual(errs, []));
} finally {
  await chrome.close();
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

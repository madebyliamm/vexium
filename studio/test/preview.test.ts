import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { CSS_MESSAGE, PICK_MESSAGE, SDK_URL, STYLE_ID, UNPICK_MESSAGE, buildPreviewHtml, cleanPicked, inertScript, inertStyle, pageOfLink, readPreviewMessage } from '../src/lib/preview.ts';

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body><header data-vx-nav></header><h1>{{VEXIUM_PROJECT_ID}}</h1><script src="site.js"></script></body></html>';
const files = { 'index.html': HTML, 'styles.css': ':root{--accent:#111}', 'site.js': 'window.SITE={name:"x"}' };

describe('buildPreviewHtml', () => {
  const html = buildPreviewHtml({ projectId: 'proj_1', page: 'index.html', files });

  it('inlines the stylesheet as the swappable <style id> and the script, with no external links to project files', () => {
    assert.ok(html.includes(`<style id="${STYLE_ID}">:root{--accent:#111}</style>`));
    assert.ok(html.includes('<script>window.SITE={name:"x"}</script>'));
    assert.ok(!html.includes('href="styles.css"') && !html.includes('src="site.js"'));
  });

  it('puts the bridge, the site id and the SDK first in <head>', () => {
    const head = html.indexOf('<head>');
    assert.ok(html.indexOf('window.__VX={site:"proj_1",page:"index.html"') > head);
    assert.ok(html.indexOf(SDK_URL) > html.indexOf('window.__VX'), '__VX is defined before the SDK reads it');
    assert.ok(html.indexOf('window.__VX') < html.indexOf('<meta charset'));
  });

  it('fills the project id placeholder', () => {
    assert.ok(html.includes('<h1>proj_1</h1>'));
  });

  it('shows the draft stylesheet instead of the saved one when given', () => {
    const draft = buildPreviewHtml({ projectId: 'p', page: 'index.html', files, css: ':root{--accent:#0f0}' });
    assert.ok(draft.includes('--accent:#0f0') && !draft.includes('--accent:#111'));
  });

  it('adds the stylesheet itself when the page forgot to link it, so the vibe controls still work', () => {
    const bare = buildPreviewHtml({ projectId: 'p', page: 'index.html', files: { ...files, 'index.html': '<html><head></head><body>hi</body></html>' } });
    assert.ok(bare.includes(`<style id="${STYLE_ID}">`));
    const noHead = buildPreviewHtml({ projectId: 'p', page: 'index.html', files: { ...files, 'index.html': '<p>hi</p>' } });
    assert.ok(noHead.includes(`<style id="${STYLE_ID}">`) && noHead.includes('<p>hi</p>'));
  });

  it('cannot be broken out of by a closing tag inside the CSS or script', () => {
    const evil = buildPreviewHtml({ projectId: 'p', page: 'index.html', files: { ...files, 'styles.css': 'a{} </style><script>alert(1)</script>', 'site.js': 'var s="</script><b>"' } });
    assert.ok(!evil.includes('</style><script>alert(1)'));
    assert.equal((evil.match(/<\/script>/g) ?? []).length, (evil.match(/<script/g) ?? []).length, 'every script tag is closed exactly once');
    assert.equal(inertStyle('</STYLE>'), '<\\/style>');
    assert.equal(inertScript('</Script>'), '<\\/script>');
  });

  it('survives a missing page', () => {
    assert.ok(buildPreviewHtml({ projectId: 'p', page: 'index.html', files: {} }).includes('window.__VX'));
  });

  it('a project id with quotes cannot break the boot script', () => {
    const h = buildPreviewHtml({ projectId: '"};alert(1);//', page: 'index.html', files });
    assert.ok(h.includes(JSON.stringify('"};alert(1);//')));
  });
});

describe('messages from the preview', () => {
  const win = {};
  it('accepts ours, from our window only', () => {
    assert.deepEqual(readPreviewMessage({ source: win, data: { source: 'vx-preview', type: 'ready' } }, win), { source: 'vx-preview', type: 'ready' });
    assert.equal(readPreviewMessage({ source: {}, data: { source: 'vx-preview', type: 'ready' } }, win), null, 'another window');
    assert.equal(readPreviewMessage({ source: win, data: { type: 'ready' } }, win), null, 'not marked as ours');
    assert.equal(readPreviewMessage({ source: win, data: 'ready' }, win), null);
    assert.equal(readPreviewMessage({ source: null, data: { source: 'vx-preview', type: 'ready' } }, null), null);
    assert.equal(readPreviewMessage({ source: win, data: { source: 'vx-preview', type: 'close-everything' } }, win), null);
  });
  it('trims long text', () => {
    const m = readPreviewMessage({ source: win, data: { source: 'vx-preview', type: 'error', message: 'x'.repeat(900) } }, win);
    assert.equal(m?.type === 'error' && m.message.length, 300);
  });
  it('the message the preview listens for is the one the studio sends', () => {
    assert.equal(CSS_MESSAGE, 'vx-css');
    assert.ok(buildPreviewHtml({ projectId: 'p', page: 'index.html', files }).includes('d.type!=="vx-css"'));
  });
});

describe('pageOfLink', () => {
  it('names the page a link goes to, or null when it is not another page', () => {
    assert.equal(pageOfLink('contact.html'), 'contact.html');
    assert.equal(pageOfLink('./about.html#team'), 'about.html');
    assert.equal(pageOfLink('/pricing?x=1'), 'pricing.html');
    for (const x of ['', '#hero', 'https://x.com', '//x.com', 'mailto:a@b.c', 'tel:1', 'javascript:1', '/', 'data:x']) assert.equal(pageOfLink(x), null, x);
  });
});

// ── pick mode ──────────────────────────────────────────────────────────────────────────────────────

describe('cleanPicked / readPreviewMessage: what a page says it was clicked on', () => {
  const win = {};
  const good = { source: 'vx-preview', type: 'pick', page: 'index.html', selector: 'main > h1', tag: 'H1', text: ' Hello   there ', html: '<h1>Hello there</h1>' };
  it('is tidied: tag lower-case, whitespace squeezed, sizes capped', () => {
    assert.deepEqual(cleanPicked(good), { page: 'index.html', selector: 'main > h1', tag: 'h1', text: 'Hello there', html: '<h1>Hello there</h1>' });
    const big = cleanPicked({ ...good, selector: 's'.repeat(900), text: 't'.repeat(900), html: 'h'.repeat(9000) })!;
    assert.deepEqual([big.selector.length, big.text.length, big.html.length], [300, 300, 1500]);
  });
  it('is refused when it is not a page of the site or not an element', () => {
    for (const bad of [null, 'x', { ...good, page: '../x.html' }, { ...good, page: 'x.js' }, { ...good, tag: '<img onerror>' }, { ...good, tag: 7 }, { ...good, page: undefined }]) assert.equal(cleanPicked(bad), null, JSON.stringify(bad));
  });
  it('arrives only from our own window', () => {
    assert.deepEqual(readPreviewMessage({ source: win, data: good }, win), { source: 'vx-preview', type: 'pick', page: 'index.html', selector: 'main > h1', tag: 'h1', text: 'Hello there', html: '<h1>Hello there</h1>' });
    assert.equal(readPreviewMessage({ source: {}, data: good }, win), null);
    assert.equal(readPreviewMessage({ source: win, data: { ...good, tag: '' } }, win), null);
  });
});

/** A just-big-enough DOM to run the bridge in: elements with a parent, children, attributes and text. */
class El {
  nodeType = 1;
  children: El[] = [];
  attrs = new Map<string, string>();
  parentElement: El | null = null;
  tagName: string;
  innerText: string;
  constructor(tagName: string, attrs: Record<string, string> = {}, innerText = '') {
    this.tagName = tagName;
    this.innerText = innerText;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    this.id = attrs.id ?? '';
  }
  add(...kids: El[]): this { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  id = '';
  textContent = '';
  appendChild(k: El): El { this.add(k); return k; }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  toggleAttribute(n: string, on: boolean): void { if (on) this.attrs.set(n, ''); else this.attrs.delete(n); }
  get outerHTML(): string { return `<${this.tagName.toLowerCase()}${[...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')}>${this.innerText}</${this.tagName.toLowerCase()}>`; }
}

function runBridge() {
  const html = buildPreviewHtml({ projectId: 'p', page: 'index.html', files });
  const code = /<script>(\(function\(\)\{[\s\S]*?\}\)\(\);)<\/script>/.exec(html)![1]!;
  const posted: Record<string, unknown>[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const root = new El('HTML');
  const body = new El('BODY');
  const main = new El('MAIN');
  const hero = new El('SECTION', { class: 'hero big wide' });
  const h1 = new El('H1', {}, 'Candles   poured by hand');
  const p1 = new El('P', {}, 'one');
  const p2 = new El('P', {}, 'two');
  const nav = new El('HEADER', { 'data-vx-nav': '' });
  const link = new El('A', { id: 'brand' }, 'Home');
  root.add(body);
  body.add(nav, main);
  nav.add(link);
  main.add(hero);
  hero.add(h1, p1, p2);
  const document = { body, documentElement: root, head: new El('HEAD'), getElementById: () => null, createElement: (t: string) => new El(t.toUpperCase()) };
  const window = { __VX: { page: 'shop.html' }, addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f) };
  vm.runInNewContext(code, { window, document, parent, Element: El, setTimeout });
  const fire = (type: string, e: Record<string, unknown>) => { for (const f of listeners[type] ?? []) f(e); };
  const click = (target: El) => {
    const ev = { target, defaultPrevented: false, stopped: false, button: 0, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    fire('click', ev);
    return ev;
  };
  const message = (data: Record<string, unknown>, fromParent = true) => fire('message', { data, source: fromParent ? parent : {} });
  return { posted, root, click, message, fire, els: { h1, p1, p2, nav, link, body, hero } };
}

describe('the pick-mode code that runs inside the page', () => {
  it('does nothing until the studio turns it on', () => {
    const b = runBridge();
    const ev = b.click(b.els.h1);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(b.posted.filter((m) => m.type === 'pick').length, 0);
  });
  it('on: a click reports the element (page, selector, tag, text, html) and does not do what the click normally does', () => {
    const b = runBridge();
    b.message({ type: PICK_MESSAGE, on: true });
    assert.ok(b.root.hasAttribute('data-vx-picking'));
    const ev = b.click(b.els.h1);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(ev.stopped, true, "the page's own handlers never see the click");
    const pick = JSON.parse(JSON.stringify(b.posted.find((m) => m.type === 'pick')!)) as Record<string, unknown>; // out of the page's realm
    assert.deepEqual(pick, { type: 'pick', source: 'vx-preview', page: 'shop.html', selector: 'main > section.hero.big > h1', tag: 'h1', text: 'Candles poured by hand', html: '<h1>Candles   poured by hand</h1>' });
    assert.ok(b.els.h1.hasAttribute('data-vx-picked'));
    assert.ok(!(pick.html as string).includes('data-vx-picked'), 'the studio\'s own mark is not part of the page');
  });
  it('tells repeated siblings apart, stops at an id, and names the menu and footer slots', () => {
    const b = runBridge();
    b.message({ type: PICK_MESSAGE, on: true });
    b.click(b.els.p2);
    b.click(b.els.link);
    const sels = b.posted.filter((m) => m.type === 'pick').map((m) => String(m.selector));
    assert.deepEqual(sels, ['main > section.hero.big > p:nth-of-type(2)', 'a#brand']);
  });
  it('only one element is marked at a time; unpick and off clear the marks', () => {
    const b = runBridge();
    b.message({ type: PICK_MESSAGE, on: true });
    b.click(b.els.h1);
    b.click(b.els.p1);
    assert.ok(!b.els.h1.hasAttribute('data-vx-picked') && b.els.p1.hasAttribute('data-vx-picked'));
    b.message({ type: UNPICK_MESSAGE });
    assert.ok(!b.els.p1.hasAttribute('data-vx-picked'));
    b.fire('mouseover', { target: b.els.p2 });
    assert.ok(b.els.p2.hasAttribute('data-vx-hover'));
    b.message({ type: PICK_MESSAGE, on: false });
    assert.ok(!b.els.p2.hasAttribute('data-vx-hover') && !b.root.hasAttribute('data-vx-picking'));
  });
  it('the page itself cannot be picked, and only the studio can switch the mode', () => {
    const b = runBridge();
    b.message({ type: PICK_MESSAGE, on: true }, false);
    assert.ok(!b.root.hasAttribute('data-vx-picking'), 'a message from anywhere but the studio is ignored');
    b.message({ type: PICK_MESSAGE, on: true });
    b.click(b.els.body);
    assert.equal(b.posted.filter((m) => m.type === 'pick').length, 0);
  });
});

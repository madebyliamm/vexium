import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CSS_MESSAGE, SDK_URL, STYLE_ID, buildPreviewHtml, inertScript, inertStyle, pageOfLink, readPreviewMessage } from '../src/lib/preview.ts';

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

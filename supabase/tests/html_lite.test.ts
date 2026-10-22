// The verifier's HTML reader and JS bracket check — run:  node --test supabase/tests/html_lite.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allEls, decodeEntities, hasAncestor, jsBalanceProblem, parseHtml, visibleText } from '../functions/ai-chat/html-lite.ts';

describe('parseHtml', () => {
  const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Hi &amp; bye</title><link rel="stylesheet" href="styles.css"/>
<style>.a > .b { color: red }</style></head>
<body><header data-vx-nav></header>
<!-- TODO: fix -->
<main><section id="hero"><h1>Hello <em>world</em></h1><p>One<p>Two</section>
<form data-vx-form="contact" data-vx-success="It's sent"><input name="email" type="email" required><textarea name="msg"></textarea><button>Send</button><p data-vx-message></p></form>
<a href='about.html' class=btn>About</a></main>
<footer data-vx-footer></footer><script src="site.js"></script><script>if (a < b && c > d) { go('</div>') }</script></body></html>`;
  const p = parseHtml(page);

  it('reads structure, attributes (any quoting) and what it saw', () => {
    assert.deepEqual(p.seen, { doctype: true, htmlEnd: true, bodyEnd: true });
    const els = allEls(p.root);
    assert.equal(els.find((e) => e.tag === 'html')!.attrs.lang, 'en');
    assert.equal(els.find((e) => e.tag === 'form')!.attrs['data-vx-success'], "It's sent");
    const a = els.find((e) => e.tag === 'a')!;
    assert.deepEqual([a.attrs.href, a.attrs.class], ['about.html', 'btn']);
    assert.equal(els.find((e) => e.tag === 'input')!.attrs.required, '');
    assert.ok('data-vx-message' in els.find((e) => e.tag === 'p' && 'data-vx-message' in e.attrs)!.attrs);
  });

  it('keeps script and style text raw, even when it contains < > or an end tag inside a string', () => {
    assert.equal(p.scripts.length, 2);
    assert.equal(p.scripts[0]!.src, 'site.js');
    assert.match(p.scripts[1]!.code, /a < b && c > d/);
    assert.deepEqual(p.styles, ['.a > .b { color: red }']);
  });

  it('collects comments and the visible text without script, style or comment content', () => {
    assert.deepEqual(p.comments.map((c) => c.trim()), ['TODO: fix']);
    const body = allEls(p.root).find((e) => e.tag === 'body')!;
    const text = visibleText(body);
    assert.match(text, /Hello world/);
    assert.doesNotMatch(text, /TODO|color: red|go\(/);
  });

  it('nests elements and knows ancestors; an unclosed <p> does not break the section', () => {
    const els = allEls(p.root);
    const input = els.find((e) => e.tag === 'input')!;
    assert.ok(hasAncestor(input, (e) => e.tag === 'form'));
    assert.ok(!hasAncestor(els.find((e) => e.tag === 'footer')!, (e) => e.tag === 'form'));
    assert.equal(els.find((e) => e.tag === 'section')!.children.some((c) => 'tag' in c && c.tag === 'h1'), true);
  });

  it('survives a page that is cut off', () => {
    const cut = parseHtml('<html><body><section><h1>Half a pa');
    assert.equal(cut.seen.htmlEnd, false);
    assert.equal(visibleText(allEls(cut.root).find((e) => e.tag === 'h1')!), 'Half a pa');
  });

  it('survives a > inside a quoted attribute and a lone <', () => {
    const q = parseHtml('<a href="x.html" title="a > b">1 < 2</a>');
    const a = allEls(q.root)[0]!;
    assert.equal(a.attrs.title, 'a > b');
    assert.equal(visibleText(a), '1 < 2');
  });

  it('decodes entities', () => {
    assert.equal(decodeEntities('Fish &amp; Chips &#169; &#x41; &unknown;'), 'Fish & Chips © A &unknown;');
  });
});

describe('jsBalanceProblem', () => {
  const ok = [
    'function a(){ return [1,2,{x:(3)}]; }',
    `const s = "}{)(" + '][' ; // } ( [`,
    '/* ) */ var x = 1;',
    'const t = `a ${b ? `n${c}` : "}"} z`; f(t)',
    'const r = /[)}]+/g.test(x) ? 1 : 2; const d = a / b / c;',
    'if (x) { y = /ab+c/i } else { z = 4 / 2 }',
    "el.addEventListener('click', () => { go('x.html'); });",
    'return;',
  ];
  for (const code of ok) it(`accepts: ${code.slice(0, 50)}`, () => assert.equal(jsBalanceProblem(code), null));

  it('finds a script that was cut off', () => {
    assert.match(jsBalanceProblem('function go() { if (a) { run(')!, /never closed|cut off/);
    assert.match(jsBalanceProblem('const x = {a: [1, 2')!, /never closed/);
  });
  it('finds mismatched and stray brackets', () => {
    assert.match(jsBalanceProblem('f(a]')!, /closes/);
    assert.match(jsBalanceProblem('a); b')!, /stray/);
  });
  it('finds an open string, comment or template', () => {
    assert.match(jsBalanceProblem(`var s = "abc\nvar t = 1`)!, /text string/);
    assert.match(jsBalanceProblem('/* never ends')!, /comment/);
    assert.match(jsBalanceProblem('const t = `abc ${x')!, /never closed|template/);
    assert.match(jsBalanceProblem('const t = `abc')!, /template/);
  });
});

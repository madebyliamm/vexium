// The launch verifier — run:  node --test supabase/tests/verifier.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../functions/_shared/artifacts.ts';
import { planBuild } from '../functions/ai-chat/build-plan.ts';
import { assembleSite } from '../functions/ai-chat/site-derive.ts';
import { repairable, verifySite, type VerifyResult } from '../functions/ai-chat/verifier.ts';
import { EXAMPLE_CSS, STYLE } from './site_fixtures.ts';

const head = (title: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="description" content="Hand-poured soy candles from Wick &amp; Co."/><title>${title}</title><link rel="stylesheet" href="styles.css"/></head>`;
const wrap = (title: string, main: string, tail = '') => `${head(title)}<body><header data-vx-nav></header><main>${main}</main><footer data-vx-footer></footer><script src="site.js"></script>${tail}</body></html>`;

const HOME = wrap('Wick & Co', `<section class="hero" id="top"><h1>Candles poured by hand</h1><p>Small-batch soy candles in a handful of scents, poured one at a time and shipped to your door.</p><a class="btn" href="shop.html">Shop candles</a></section>
<section id="why"><h2>Why soy</h2><p>Soy wax burns cleanly and holds a scent well, so each candle fills a room without overpowering it.</p></section>`);
const SHOP = wrap('Shop', `<section><h1>Shop</h1><article><h2>Amber candle</h2><p>Warm amber and cedar in a plain glass jar.</p><p class="price">$24</p><button data-vx-buy="candle">Buy now</button></article></section>`);
const CONTACT = wrap('Contact', `<section><h1>Contact</h1><p>Questions about an order or a scent? Write to us and we will reply.</p><form data-vx-form="contact" data-vx-success="Thanks, we will be in touch."><label>Email <input type="email" name="email" required></label><label>Message <textarea name="message" required></textarea></label><button type="submit">Send</button><p data-vx-message></p></form></section>`);

function plan(patch: Partial<Plan> = {}): Plan {
  const base = emptyPlan('Wick & Co');
  return {
    ...base,
    one_liner: 'Hand-poured candles',
    pages: [{ file: 'index.html', title: 'Home', purpose: 'Introduce the candles' }, { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' }, { file: 'contact.html', title: 'Contact', purpose: 'Get in touch' }],
    pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2400 }] },
    backend: { collections: [], products: ['candle'], forms: ['contact'], auth: false },
    launch_checklist: [{ id: 'photos', label: 'Real product photos', type: 'photo', done: false }],
    ...patch,
  };
}

function build(pages: Record<string, string> = { 'index.html': HOME, 'shop.html': SHOP, 'contact.html': CONTACT }, p: Plan = plan()) {
  const spec = planBuild(p);
  const a = assembleSite({ plan: p, spec, style: STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS }, pages });
  return { p, spec, files: { ...a.files, ...pages } };
}
function verify(pages?: Record<string, string>, p?: Plan, extra: { otherFiles?: string[]; pageErrors?: Record<string, string> } = {}): VerifyResult {
  const b = build(pages, p);
  return verifySite({ plan: b.p, spec: b.spec, style: STYLE, files: b.files, ...extra });
}
const status = (r: VerifyResult, id: string) => r.checks.find((c) => c.id === id)!.status;
const messages = (r: VerifyResult, check: string) => r.problems.filter((p) => p.check === check).map((p) => `${p.file}: ${p.message}`);
const withPage = (file: string, html: string) => ({ 'index.html': HOME, 'shop.html': SHOP, 'contact.html': CONTACT, [file]: html });

describe('a complete site', () => {
  const r = verify();
  it('passes with nothing failing, and reports what only the owner can supply', () => {
    assert.deepEqual(r.problems.filter((p) => p.severity === 'fail'), []);
    assert.equal(r.ok, true);
    assert.equal(status(r, 'owner'), 'warn');
    assert.deepEqual(r.open_items, ['Real product photos']);
  });
  it('reports every check once, in a fixed order, with the checks that do not apply skipped', () => {
    assert.equal(new Set(r.checks.map((c) => c.id)).size, r.checks.length);
    assert.equal(r.checks[0]!.id, 'pages');
    assert.equal(status(r, 'accounts'), 'skip');
    assert.equal(status(r, 'checkout'), 'pass');
    assert.equal(status(r, 'forms'), 'pass');
    assert.equal(status(r, 'links'), 'pass');
  });
  it('has nothing to repair', () => assert.equal(repairable(r, build().spec).size, 0));
});

describe('pages', () => {
  it('fails a page that is missing or empty, quoting why when the build knows', () => {
    const r = verify({ 'index.html': HOME, 'shop.html': '', 'contact.html': CONTACT }, undefined, { pageErrors: { 'shop.html': 'the model ran out of room' } });
    assert.equal(status(r, 'pages'), 'fail');
    assert.match(messages(r, 'pages')[0]!, /shop\.html: This page could not be built: the model ran out of room/);
    assert.equal(r.ok, false);
  });
  it('fails a page that was cut off, and one that forgot the shared files', () => {
    const cut = HOME.replace('</body></html>', '');
    assert.match(messages(verify(withPage('index.html', cut)), 'structure').join(' '), /cut off/);
    const bare = HOME.replace('<script src="site.js"></script>', '').replace('<link rel="stylesheet" href="styles.css"/>', '').replace('<header data-vx-nav></header>', '').replace('<footer data-vx-footer></footer>', '');
    const m = messages(verify(withPage('index.html', bare)), 'structure').join(' ');
    for (const w of [/styles\.css/, /site\.js/, /data-vx-nav/, /data-vx-footer/]) assert.match(m, w);
  });
});

describe('scripts', () => {
  it('fails an inline script that ends mid-function', () => {
    const r = verify(withPage('index.html', wrap('Wick & Co', '<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p></section>', '<script>function go() { if (a) { run(</script>')));
    assert.equal(status(r, 'scripts'), 'fail');
    assert.match(messages(r, 'scripts')[0]!, /Inline script 1 is broken/);
  });
  it('accepts a working one', () => {
    const r = verify(withPage('index.html', wrap('Wick & Co', '<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p></section>', '<script>document.querySelector("h1").addEventListener("click", () => { go(`a ${1}`); });</script>')));
    assert.equal(status(r, 'scripts'), 'pass');
  });
});

describe('links', () => {
  const page = (inner: string) => wrap('Wick & Co', `<section id="top"><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p><span id="why"></span>${inner}</section>`);
  const links = (inner: string) => messages(verify(withPage('index.html', page(inner))), 'links');
  it('fails links to nowhere, to missing pages and anchors, and to absolute paths', () => {
    const m = links('<a href="#">Top</a><a href="">Empty</a><a href="about.html">About</a><a href="#nope">Jump</a><a href="shop.html#nothing">Shop</a><a href="/shop.html">Abs</a><a href="javascript:go()">Run</a>').join('\n');
    assert.match(m, /"Top" goes nowhere/);
    assert.match(m, /"Empty" goes nowhere/);
    assert.match(m, /goes to about\.html, which is not a page of this site\. Pages that exist: index\.html, shop\.html, contact\.html/);
    assert.match(m, /#nope/);
    assert.match(m, /shop\.html#nothing/);
    assert.match(m, /absolute path "\/shop\.html"/);
    assert.match(m, /javascript: address/);
  });
  it('accepts real pages, existing anchors, outside links, mail and phone', () => {
    assert.deepEqual(links('<a href="shop.html">Shop</a><a href="./contact.html">Contact</a><a href="#top">Top</a><a href="index.html#why">Why</a><a href="https://example.org/x">Out</a><a href="mailto:hi@wick.example">Mail</a><a href="tel:+15551234567">Call</a>'), []);
  });
  it('fails a button that is not a link, not in a form, and not wired to anything when the page has no script', () => {
    assert.match(links('<button>Menu</button>').join(' '), /The button "Menu" does nothing/);
    assert.deepEqual(links('<button data-vx-buy="candle">Buy</button><form data-vx-form="contact"><input name="email" type="email"><button>Send</button><p data-vx-message></p></form><a href="shop.html"><button>Go</button></a>'), []);
  });
  it('warns about a link to a file the project does not have', () => {
    const r = verify(withPage('index.html', page('<a href="menu.pdf">Menu</a>')));
    assert.equal(status(r, 'links'), 'warn');
    assert.equal(r.ok, true);
  });
});

describe('images', () => {
  const page = (inner: string) => wrap('Wick & Co', `<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p>${inner}</section>`);
  it('fails placeholder-host and missing images; accepts the project\'s own and data URIs', () => {
    const r = verify(withPage('index.html', page('<img src="https://images.unsplash.com/photo-1" alt="Candle"><img src="candle.jpg" alt="Candle">')));
    assert.equal(status(r, 'images'), 'fail');
    assert.equal(messages(r, 'images').length, 2);
    const ok = verify(withPage('index.html', page('<img src="candle.jpg" alt="A candle"><img src="data:image/gif;base64,R0lGOD" alt="dot">')), undefined, { otherFiles: ['candle.jpg'] });
    assert.equal(status(ok, 'images'), 'pass');
  });
  it('fails a CSS url() that points nowhere, and warns on missing alt text', () => {
    const r = verify(withPage('index.html', page('<div style="background: url(hero.png)"></div><img src="candle.jpg">')), undefined, { otherFiles: ['candle.jpg'] });
    assert.match(messages(r, 'images').join(' '), /uses "hero\.png", which is not a file/);
    assert.match(messages(r, 'basics').join(' '), /no alt text/);
  });
});

describe('forms and the backend', () => {
  it('fails a form that goes nowhere, and a form with no message line or submit button', () => {
    const bad = CONTACT.replace('<p data-vx-message></p>', '').replace('<button type="submit">Send</button>', '') + '';
    const r = verify(withPage('contact.html', bad.replace('</main>', '<form action="/x"><input name="q"></form></main>')));
    const m = messages(r, 'forms').join(' ');
    assert.match(m, /would go nowhere/);
    assert.match(m, /no <p data-vx-message>/);
    assert.match(m, /no submit button/);
  });
  it('fails when a form the plan asked for is not on the page', () => {
    const r = verify(withPage('contact.html', wrap('Contact', '<section><h1>Contact</h1><p>Questions about an order or a scent? Write to us and we will reply soon.</p></section>')));
    assert.match(messages(r, 'forms').join(' '), /contact\.html: The plan needs a "contact" form on this page/);
    assert.ok(repairable(r, build().spec).get('contact.html'));
  });
  it('fails input names the backend would drop', () => {
    const r = verify(withPage('contact.html', CONTACT.replace('name="message"', 'name="your message"')));
    assert.match(messages(r, 'forms').join(' '), /"your message" in the "contact" form is not allowed/);
  });
  it('writes a backend that matches the pages (the check passes on a good build)', () => {
    assert.equal(status(verify(), 'backend'), 'pass');
  });
});

describe('checkout', () => {
  it('fails a sellable product with no buy button, and a buy button for a product the plan does not have', () => {
    const r = verify(withPage('shop.html', SHOP.replace('<button data-vx-buy="candle">Buy now</button>', '<button data-vx-buy="mug">Buy now</button>')));
    const m = messages(r, 'checkout').join(' ');
    assert.match(m, /product "mug", which is not in the plan/);
    assert.match(m, /"candle" is for sale but has no buy button/i);
  });
  it('fails a buy button for a product with no valid one-time price', () => {
    const p = plan({ pricing: { model: 'subscription', items: [{ name: 'Candle', price_cents: 2400, interval: 'month' }] } });
    const r = verify(undefined, p);
    assert.match(messages(r, 'checkout').join(' '), /no valid one-time price/);
    assert.ok(r.open_items.some((o) => /monthly|recurring|subscription|interval|online/i.test(o)));
  });
  it('skips the check when nothing is for sale', () => {
    const r = verify({ 'index.html': HOME.replace('Shop candles', 'Contact us').replace('shop.html', 'contact.html'), 'contact.html': CONTACT }, plan({ pages: [{ file: 'index.html', title: 'Home', purpose: '' }, { file: 'contact.html', title: 'Contact', purpose: '' }], pricing: { model: 'free', items: [] }, backend: { collections: [], products: [], forms: ['contact'], auth: false } }));
    assert.equal(status(r, 'checkout'), 'skip');
  });
});

describe('accounts', () => {
  const authPlan = plan({ backend: { collections: [], products: ['candle'], forms: ['contact'], auth: true } });
  const login = wrap('Log in', '<section><h1>Log in</h1><p>Welcome back. Sign in to see your orders.</p><form data-vx-auth="login" data-vx-redirect="index.html"><label>Email <input type="email" name="email" required></label><label>Password <input type="password" name="password" required></label><button type="submit">Log in</button><p data-vx-message></p></form></section>', '');
  const signup = login.replace(/data-vx-auth="login"/, 'data-vx-auth="signup"').replace(/Log in/g, 'Sign up');
  const pages = { 'index.html': HOME, 'shop.html': SHOP, 'contact.html': CONTACT, 'login.html': login, 'signup.html': signup };
  it('passes when the log-in and sign-up pages have working forms', () => {
    const r = verify(pages, authPlan);
    assert.equal(status(r, 'accounts'), 'pass');
    assert.equal(r.ok, true);
  });
  it('fails a sign-in page without the form, or with no password input', () => {
    const r = verify({ ...pages, 'login.html': wrap('Log in', '<section><h1>Log in</h1><p>Welcome back. Sign in to see your orders at any time.</p></section>'), 'signup.html': signup.replace('name="password"', 'name="pw"') }, authPlan);
    const m = messages(r, 'accounts').join(' ');
    assert.match(m, /login\.html: This log-in page has no <form data-vx-auth="login">/);
    assert.match(m, /signup form needs inputs named "email" and "password"/);
  });
  it('fails a sign-in redirect to a page that is not there', () => {
    const r = verify({ ...pages, 'login.html': login.replace('index.html', 'dashboard.html') }, authPlan);
    assert.match(messages(r, 'accounts').join(' '), /redirect goes to dashboard\.html/);
  });
});

describe('content', () => {
  const page = (inner: string) => withPage('index.html', wrap('Wick & Co', `<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p>${inner}</section>`));
  it('fails placeholder text of every common kind', () => {
    for (const bad of ['Lorem ipsum dolor sit amet', 'Coming soon', 'Your text here', '[Company Name]', 'John Doe', 'Call (555) 123-4567', 'Write to hello@example.com', '123 Main St', '{{name}}']) {
      const r = verify(page(`<p>${bad}</p>`));
      assert.equal(status(r, 'content'), 'fail', bad);
    }
  });
  it('fails a placeholder note left in an HTML comment', () => {
    assert.equal(status(verify(page('<!-- TODO: add testimonials here -->')), 'content'), 'fail');
    assert.equal(status(verify(page('<!-- Hero section -->')), 'content'), 'pass');
  });
  it('allows a phrase the owner wrote in the plan themselves', () => {
    const p = plan({ one_liner: 'Hand-poured candles — coming soon to your doorstep' });
    const r = verify(withPage('index.html', wrap('Wick & Co', '<section><h1>Candles</h1><p>Small-batch soy candles, coming soon to your doorstep, poured by hand for your home.</p></section>')), p);
    assert.equal(status(r, 'content'), 'pass');
  });
});

describe('invented proof and prices', () => {
  const page = (inner: string) => withPage('index.html', wrap('Wick & Co', `<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p>${inner}</section>`));
  it('fails testimonials, logo strips, ratings, counts and awards the owner never gave', () => {
    for (const bad of ['<p>Trusted by 500 happy customers</p>', '<p>★★★★★ Best candle ever</p>', '<p>Rated 4.9/5</p>', '<p>Our award-winning scents</p>', '<p>Join 10,000+ subscribers</p>', '<div class="testimonials"><p>Lovely.</p></div>', '<p>As seen in Vogue</p>']) {
      assert.equal(status(verify(page(bad)), 'proof'), 'fail', bad);
    }
  });
  it('warns about shipping terms, guarantees, percentages and years in business without failing the build', () => {
    const r = verify(page('<p>Free shipping on every order. Since 2015 we pour candles. 30-day returns.</p>'));
    assert.equal(status(r, 'proof'), 'warn');
    assert.equal(r.ok, true);
  });
  it('flags a quotation for the owner to confirm', () => {
    assert.equal(status(verify(page('<blockquote>Lovely candles</blockquote>')), 'proof'), 'warn');
  });
  it('fails a price that is not in the plan, accepts the plan\'s own, and does not check prices for donations', () => {
    assert.equal(status(verify(page('<p>Gift sets from $59</p>')), 'prices'), 'fail');
    assert.equal(status(verify(page('<p>Candles are $24 each</p>')), 'prices'), 'pass');
    const don = plan({ pricing: { model: 'donation', items: [] }, backend: { collections: [], products: [], forms: ['contact'], auth: false } });
    assert.equal(status(verify({ 'index.html': HOME.replace('shop.html', 'contact.html'), 'contact.html': CONTACT }, { ...don, pages: [don.pages[0]!, don.pages[2]!] }), 'prices'), 'skip');
  });
});

describe('empty sections, hidden content and style', () => {
  const page = (inner: string) => withPage('index.html', wrap('Wick & Co', `<section><h1>Candles</h1><p>Small-batch soy candles poured by hand, one at a time, for your home.</p>${inner}</section>`));
  it('fails a page with almost nothing on it and a section with a heading and no body', () => {
    assert.equal(status(verify(withPage('index.html', wrap('Wick & Co', '<section><h1>Candles</h1></section>'))), 'empty'), 'fail');
    const r = verify(page('</section><section id="faq"><h2>Questions</h2></section><section><p>x</p>'));
    assert.match(messages(r, 'empty').join(' '), /\(#faq\) titled "Questions" has no content/);
  });
  it('does not call a section with a form, button or image empty', () => {
    assert.equal(status(verify(page('</section><section><h2>Stay in touch</h2><a href="contact.html">Write to us</a></section><section><p>x</p>')), 'empty'), 'pass');
  });
  it('warns about opacity:0 and raw colours; allows neutral shadows and token colours', () => {
    const css = (rule: string) => page(`<style>${rule}</style>`);
    assert.equal(status(verify(css('.reveal { opacity: 0; transform: translateY(24px) }')), 'visibility'), 'warn');
    assert.equal(status(verify(css('.card { background: #fafafa; }')), 'style'), 'warn');
    assert.equal(status(verify(css('.card { box-shadow: 0 8px 24px rgba(0,0,0,.12); background: var(--surface); color: color-mix(in srgb, var(--accent) 80%, black); border: 1px solid var(--border) }')), 'style'), 'pass');
    assert.equal(status(verify(css('.art { --wax: #e8c090; background: var(--wax); }')), 'style'), 'pass');
  });
  it('fails a styles.css that drifted from the locked style', () => {
    const b = build();
    const r = verifySite({ plan: b.p, spec: b.spec, style: STYLE, files: { ...b.files, 'styles.css': b.files['styles.css']!.replace('#b4532a', '#123456') } });
    assert.match(messages(r, 'style').join(' '), /styles\.css does not match the locked style \(--accent\)/);
  });
});

describe('basics', () => {
  it('warns about a missing title, description, viewport, language and h1 without failing', () => {
    const bare = '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"/></head><body><header data-vx-nav></header><main><section><h2>Candles</h2><p>Small-batch soy candles poured by hand, one at a time, for your home.</p></section></main><footer data-vx-footer></footer><script src="site.js"></script></body></html>';
    const r = verify(withPage('index.html', bare));
    assert.equal(status(r, 'basics'), 'warn');
    assert.equal(messages(r, 'basics').length, 5);
    assert.equal(r.ok, true);
  });
});

describe('repairable', () => {
  it('groups only failures on the build\'s own pages, never warnings or platform-derived files', () => {
    const b = build(withPage('index.html', HOME.replace('Shop candles', 'Shop').replace('shop.html', 'gone.html').replace('<h1>', '<h1 class="x">')));
    const r = verifySite({ plan: b.p, spec: b.spec, style: STYLE, files: { ...b.files, 'styles.css': '' } });
    const map = repairable(r, b.spec);
    assert.deepEqual([...map.keys()], ['index.html']);
    assert.ok(map.get('index.html')!.every((p) => p.severity === 'fail'));
    assert.ok(r.problems.some((p) => p.file === 'styles.css'));
  });
});

describe('report shape', () => {
  it('turns each failing check into a plain detail with the page when it is one page', () => {
    const r = verify(withPage('index.html', HOME.replace('Shop candles', 'Top').replace('href="shop.html"', 'href="#"')));
    const links = r.checks.find((c) => c.id === 'links')!;
    assert.equal(links.status, 'fail');
    assert.equal(links.page, 'index.html');
    assert.match(links.detail!, /index\.html: The link "Top" goes nowhere/);
    assert.ok(links.detail!.length <= 900);
  });
});

// FULL BUILD assembly — run:  node --test supabase/tests/site_derive.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../functions/_shared/artifacts.ts';
import { parseTokens } from '../functions/_shared/style.ts';
import { planBuild } from '../functions/ai-chat/build-plan.ts';
import { assembleSite, deriveBackend, deriveManifestJson, deriveSiteJs, finishStylesheet, FORM_KIT, readPreviousSite, scanPage } from '../functions/ai-chat/site-derive.ts';
import { jsBalanceProblem } from '../functions/ai-chat/html-lite.ts';
import { EXAMPLE_CSS, STYLE } from './site_fixtures.ts';

const shell = (title: string, body: string, htmlAttrs = '') =>
  `<!DOCTYPE html><html lang="en"${htmlAttrs}><head><meta charset="UTF-8"/><title>${title}</title><link rel="stylesheet" href="styles.css"/></head><body><header data-vx-nav></header><main>${body}</main><footer data-vx-footer></footer><script src="site.js"></script></body></html>`;

const contactForm = `<form data-vx-form="contact" data-vx-success="Thanks!">
  <label>Name <input name="name" required maxlength="80"></label>
  <label>Email <input type="email" name="email" required></label>
  <label>Message <textarea name="message"></textarea></label>
  <label><input type="checkbox" name="subscribe"> Keep me posted</label>
  <input type="hidden" name="source" value="site"><input type="file" name="cv">
  <button type="submit">Send</button><p data-vx-message></p></form>`;

function plan(patch: Partial<Plan> & { backend?: Partial<Plan['backend']> } = {}): Plan {
  const base = emptyPlan('Wick & Co');
  return { ...base, one_liner: 'Hand-poured candles', ...patch, backend: { ...base.backend, ...(patch.backend ?? {}) } };
}

describe('scanPage', () => {
  const s = scanPage('contact.html', shell('Contact', `<section id="top"><h1>Hi</h1>${contactForm}</section>
    <form action="/x"><input name="q"></form><div data-vx-form="oops"></div>
    <button data-vx-buy="candle">Buy</button><button data-vx-buy-amount="500">Give</button>
    <script>vx.data.list('orders').then(go); vx.data.submit("notes", {a:1})</script>`, ' data-vx-require-auth="login.html"'));

  it('reads a form: fields with types, required flags and limits; skips buttons, files, nameless inputs', () => {
    assert.equal(s.forms.length, 1);
    const f = s.forms[0]!;
    assert.equal(f.id, 'contact');
    assert.deepEqual(f.fields, [
      { key: 'name', type: 'text', required: true, max: 80 },
      { key: 'email', type: 'email', required: true, max: null },
      { key: 'message', type: 'text', required: false, max: 5000 },
      { key: 'subscribe', type: 'boolean', required: false, max: null },
      { key: 'source', type: 'text', required: false, max: 500 },
    ]);
    assert.deepEqual([f.hasMessage, f.hasSubmit, f.badNames], [true, true, []]);
  });

  it('counts dead forms, misplaced hooks, buy buttons, data calls, ids and auth hooks', () => {
    assert.equal(s.strayForms, 1);
    assert.deepEqual(s.hookOnWrongTag, ['data-vx-form="oops" on a <div>']);
    assert.deepEqual([s.buys, s.buyAmounts], [['candle'], 1]);
    assert.deepEqual(s.dataIds, ['orders', 'notes']);
    assert.deepEqual(s.ids, ['top']);
    assert.deepEqual(s.requireAuth, ['login.html']);
  });

  it('reads an auth form', () => {
    const a = scanPage('login.html', shell('Log in', '<form data-vx-auth="login" data-vx-redirect="index.html"><input name="email" type="email"><input name="password" type="password"><button>Go</button><p data-vx-message></p></form>'));
    assert.deepEqual(a.authForms, [{ kind: 'login', hasEmail: true, hasPassword: true, hasMessage: true, hasSubmit: true, redirect: 'index.html' }]);
    assert.deepEqual(a.redirects, ['index.html']);
  });

  it('reports input names the backend would drop', () => {
    const b = scanPage('x.html', shell('X', '<form data-vx-form="x"><input name="your name"><input name="ok"><button>Go</button></form>'));
    assert.deepEqual(b.forms[0]!.badNames, ['your name']);
    assert.deepEqual(b.forms[0]!.fields.map((f) => f.key), ['ok']);
  });
});

describe('deriveBackend', () => {
  const spec = planBuild(plan({
    pages: [{ file: 'index.html', title: 'Home', purpose: '' }, { file: 'contact.html', title: 'Contact', purpose: '' }],
    pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2400 }, { name: 'Tote', price_cents: 0 }] },
    backend: { forms: ['contact', 'waitlist'], collections: ['notes'], products: ['candle', 'tote'] },
  }));

  it('describes exactly the forms the pages contain, owner-readable and publicly writable, with the owner told about contact forms', () => {
    const scans = [scanPage('contact.html', shell('Contact', contactForm)), scanPage('index.html', shell('Home', '<form data-vx-form="waitlist"><input type="email" name="email" required><button>Join</button><p data-vx-message></p></form>'))];
    const { rules, summary } = deriveBackend(spec, scans);
    const contact = rules.collections.find((c) => c.id === 'contact')!;
    assert.deepEqual([contact.read, contact.write, contact.notify_owner], ['owner', 'public', true]);
    assert.deepEqual(contact.fields.map((f) => f.key), ['name', 'email', 'message', 'subscribe', 'source']);
    assert.equal(rules.collections.find((c) => c.id === 'waitlist')!.notify_owner, false);
    assert.deepEqual(summary.forms, ['contact', 'waitlist']);
    // the planned store no form fills is still there, free-form
    assert.deepEqual(rules.collections.find((c) => c.id === 'notes'), { id: 'notes', label: 'Notes', fields: [], read: 'owner', write: 'public', max_rows: 10000, notify_owner: false });
  });

  it('lists only sellable products with their stated price', () => {
    const { rules, summary } = deriveBackend(spec, []);
    assert.deepEqual(rules.products, [{ id: 'candle', name: 'candle', price_cents: 2400 }]);
    assert.deepEqual(summary.products, ['candle']);
  });

  it('turns accounts on when the plan or a page has them, and scopes free-form stores to the signed-in user', () => {
    assert.equal(deriveBackend(spec, []).rules.auth.enabled, false);
    assert.equal(deriveBackend(spec, [scanPage('login.html', shell('L', '<form data-vx-auth="login"><input name="email"><input name="password"></form>'))]).rules.auth.enabled, true);
    const app = planBuild(plan({ kind: 'app', backend: { auth: true, collections: ['tasks'] } }));
    const { rules } = deriveBackend(app, [scanPage('app.html', shell('A', '<script>vx.data.submit("tasks",{})</script>'))]);
    assert.deepEqual(rules.collections.map((c) => [c.id, c.read, c.write]), [['tasks', 'user', 'user']]);
    assert.equal(rules.auth.enabled, true);
  });

  it('merges the same form on several pages: a field only some copies have is optional; invalid ids are dropped', () => {
    const a = scanPage('a.html', shell('A', '<form data-vx-form="join"><input name="email" type="email" required><input name="city" required></form>'));
    const b = scanPage('b.html', shell('B', '<form data-vx-form="join"><input name="email" type="email" required></form><form data-vx-form="Bad Id!"><input name="x"></form>'));
    const { rules } = deriveBackend(planBuild(plan()), [a, b]);
    assert.deepEqual(rules.collections.map((c) => c.id), ['join']);
    assert.deepEqual(rules.collections[0]!.fields.map((f) => [f.key, f.required]), [['email', true], ['city', false]]);
  });

  it('produces JSON that site-api reads back to the same rules', async () => {
    const { parseBackend } = await import('../functions/site-api/rules.ts');
    const scans = [scanPage('contact.html', shell('Contact', contactForm))];
    const parsed = parseBackend(deriveBackend(spec, scans).json);
    const c = parsed.collections.get('contact')!;
    assert.deepEqual([c.read, c.write, c.notifyOwner], ['owner', 'public', true]);
    assert.deepEqual(c.fields.map((f) => [f.key, f.type, f.required]), [['name', 'text', true], ['email', 'email', true], ['message', 'text', false], ['subscribe', 'boolean', false], ['source', 'text', false]]);
    assert.equal(parsed.authEnabled, false);
  });
});

describe('site.js', () => {
  const pages = [{ file: 'index.html', title: 'Home', purpose: '' }, { file: 'menu.html', title: 'Menu', purpose: '' }, { file: 'privacy.html', title: 'Privacy', purpose: '' }, { file: 'dashboard.html', title: 'Dashboard', purpose: '' }];
  const run = (siteJs: string) => {
    const w: { SITE?: Record<string, any> } = {};
    new Function('window', siteJs)(w); // the generated file must be valid JavaScript that sets window.SITE
    return w.SITE!;
  };

  it('builds the menu from the pages: legal pages in the footer, account pages around Log in / Log out', () => {
    const spec = planBuild(plan({ pages, backend: { auth: true } }));
    const js = deriveSiteJs({ plan: plan(), spec, previous: undefined, logo: null, idsByPage: {}, protectedPages: new Set(['dashboard.html']) });
    assert.equal(jsBalanceProblem(js), null);
    const site = run(js);
    assert.equal(site.name, 'Wick & Co');
    assert.deepEqual(site.nav, [
      { label: 'Home', href: 'index.html' },
      { label: 'Menu', href: 'menu.html' },
      { label: 'Dashboard', href: 'dashboard.html', show: 'in' },
      { label: 'Log in', href: 'login.html', show: 'out' },
      { label: 'Log out', action: 'logout', show: 'in' },
    ]);
    assert.deepEqual(site.cta, { label: 'Sign up', href: 'signup.html', show: 'out' });
    assert.deepEqual(site.footer.columns.map((c: any) => [c.title, c.links.map((l: any) => l.href)]), [['Pages', ['index.html', 'menu.html']], ['Legal', ['privacy.html']]]);
    assert.deepEqual(site.footer.social, []);
    assert.equal(site.footer.legal, '© {year} Wick & Co');
    assert.equal(site.footer.tagline, 'Hand-poured candles');
  });

  it('keeps the example\'s tagline and a call to action that points somewhere real; drops one that does not (and never keeps invented social links)', () => {
    const spec = planBuild(plan({ pages }));
    const prevText = `window.SITE = { name: "Old", nav: [], cta: { label: 'Order now', href: 'menu.html#items' }, footer: { tagline: "Candles that smell like home.", columns: [{ title: "Explore", links: [] }], social: [{label:"Instagram", href:"https://instagram.com/wickco"}] } };`;
    const keep = run(deriveSiteJs({ plan: plan(), spec, previous: prevText, logo: null, idsByPage: { 'menu.html': ['items'] }, protectedPages: new Set() }));
    assert.deepEqual(keep.cta, { label: 'Order now', href: 'menu.html#items' });
    assert.equal(keep.footer.tagline, 'Candles that smell like home.');
    assert.equal(keep.footer.columns[0].title, 'Explore');
    assert.deepEqual(keep.footer.social, []);
    const gone = run(deriveSiteJs({ plan: plan(), spec, previous: prevText, logo: null, idsByPage: { 'menu.html': [] }, protectedPages: new Set() }));
    assert.equal(gone.cta, undefined);
  });

  it('shows only an owner-uploaded logo', () => {
    const spec = planBuild(plan({ pages }));
    assert.equal(run(deriveSiteJs({ plan: plan(), spec, previous: undefined, logo: 'logo.png', idsByPage: {}, protectedPages: new Set() })).logo, 'logo.png');
    assert.equal(run(deriveSiteJs({ plan: plan(), spec, previous: undefined, logo: null, idsByPage: {}, protectedPages: new Set() })).logo, undefined);
  });

  it('is safe against a name with quotes and script-like text', () => {
    const p = plan({ name: `Bob's "Best" </script><script>alert(1)//` });
    const js = deriveSiteJs({ plan: p, spec: planBuild(p), previous: undefined, logo: null, idsByPage: {}, protectedPages: new Set() });
    assert.equal(run(js).name, p.name.slice(0, 80));
  });

  it('reads the few kept values without running the old file', () => {
    assert.deepEqual(readPreviousSite(`throw new Error("never runs"); tagline: 'It\\'s ours'`), { tagline: "It's ours", cta: null, titles: [] });
    assert.deepEqual(readPreviousSite(undefined), { tagline: null, cta: null, titles: [] });
  });
});

describe('manifest.json and stylesheet', () => {
  it('writes the name and the style\'s colours', () => {
    const m = JSON.parse(deriveManifestJson(plan({ name: 'Wick & Co Candle Studio' }), STYLE));
    assert.deepEqual([m.name, m.short_name, m.background_color, m.theme_color, m.display], ['Wick & Co Candle Studio', 'Wick', '#faf7f2', '#b4532a', 'standalone']);
    assert.equal(m.icons, undefined);
  });

  it('writes the locked tokens and the one font import into styles.css, and adds the form kit exactly once', () => {
    const once = finishStylesheet(EXAMPLE_CSS, STYLE);
    const tokens = parseTokens(once);
    for (const [k, v] of Object.entries(STYLE.tokens)) assert.equal(tokens[k], v);
    assert.equal((once.match(/@import/g) ?? []).length, 1);
    assert.match(once, /family=Fraunces/);
    assert.equal((once.match(/\/\* vx-form-kit \*\//g) ?? []).length, 1);
    assert.equal(finishStylesheet(once, STYLE), once); // idempotent
    assert.ok(once.includes(FORM_KIT));
  });

  it('keeps the form kit to tokens only — no colour of its own and zero specificity', () => {
    assert.doesNotMatch(FORM_KIT, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const rule of FORM_KIT.split('}')) {
      const sel = rule.split('{')[0]!.replace(/\/\*.*?\*\//g, '').trim();
      if (sel) assert.match(sel, /^:where\(/, sel);
    }
  });
});

describe('assembleSite', () => {
  const pages = [{ file: 'index.html', title: 'Home', purpose: '' }, { file: 'contact.html', title: 'Contact', purpose: '' }];
  const p = plan({ pages, backend: { forms: ['contact'] } });
  const spec = planBuild(p);
  const html = { 'index.html': shell('Home', '<h1>Hi</h1>'), 'contact.html': shell('Contact', contactForm) };

  it('returns every file of the site, the backend included, and the stale pages to remove', () => {
    const a = assembleSite({ plan: p, spec, style: STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS, 'site.js': 'window.SITE={}', 'index.html': 'old', 'old-page.html': 'x', 'logo.png': 'data:...', _longterm: '{}' }, pages: html });
    assert.deepEqual(Object.keys(a.files).sort(), ['_backend', 'contact.html', 'index.html', 'manifest.json', 'site.js', 'styles.css']);
    assert.deepEqual(a.remove, ['old-page.html']);
    assert.deepEqual(JSON.parse(a.files._backend!).collections.map((c: any) => c.id), ['contact']);
    assert.deepEqual(a.backendSummary.forms, ['contact']);
    assert.match(a.files['site.js']!, /"logo": "logo\.png"/);
    assert.equal(a.scans.length, 2);
    assert.ok(a.files['index.html']!.endsWith('</html>\n'));
  });

  it('leaves a page out when it was not built, rather than writing an empty one', () => {
    const a = assembleSite({ plan: p, spec, style: STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS }, pages: { 'index.html': html['index.html'] } });
    assert.equal(a.files['contact.html'], undefined);
  });
});

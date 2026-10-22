// FULL BUILD planning — run:  node --test supabase/tests/build_plan.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../functions/_shared/artifacts.ts';
import { MAX_BUILD_PAGES, navPages, planBuild, slug } from '../functions/ai-chat/build-plan.ts';

const page = (file: string, title: string, purpose = '') => ({ file, title, purpose });
function plan(patch: Partial<Plan> & { backend?: Partial<Plan['backend']> } = {}): Plan {
  const base = emptyPlan('Wick & Co');
  return { ...base, ...patch, backend: { ...base.backend, ...(patch.backend ?? {}) } };
}

describe('slug', () => {
  it('makes short lowercase ids and drops accents', () => {
    assert.equal(slug('Soy Candle (Large)'), 'soy-candle-large');
    assert.equal(slug('  Café  Crème '), 'cafe-creme');
    assert.equal(slug('!!!'), '');
    assert.ok(slug('x'.repeat(100)).length <= 40);
  });
});

describe('planBuild — pages', () => {
  it('keeps the plan order with the home page first and lowercases file names', () => {
    const s = planBuild(plan({ pages: [page('About.html', 'About'), page('index.html', 'Home'), page('contact.html', 'Contact')] }));
    assert.deepEqual(s.pages.map((p) => p.file), ['index.html', 'about.html', 'contact.html']);
    assert.equal(s.pages[0]!.role, 'home');
    assert.ok(s.pages.every((p) => !p.auto));
  });

  it('adds a home page when the plan has none, and ignores duplicate files', () => {
    const s = planBuild(plan({ pages: [page('about.html', 'About'), page('ABOUT.html', 'About again')] }));
    assert.deepEqual(s.pages.map((p) => p.file), ['index.html', 'about.html']);
    assert.equal(s.pages[0]!.auto, true);
  });

  it('adds login and signup pages for a site with accounts — but not when the plan already has them', () => {
    const withAuth = planBuild(plan({ pages: [page('index.html', 'Home')], backend: { auth: true } }));
    assert.deepEqual(withAuth.pages.map((p) => [p.file, p.role, p.auto]), [['index.html', 'home', false], ['login.html', 'login', true], ['signup.html', 'signup', true]]);
    assert.equal(withAuth.auth, true);

    const own = planBuild(plan({ pages: [page('index.html', 'Home'), page('sign-in.html', 'Sign in'), page('register.html', 'Create account')], backend: { auth: true } }));
    assert.deepEqual(own.pages.map((p) => [p.file, p.role, p.auto]), [['index.html', 'home', false], ['sign-in.html', 'login', false], ['register.html', 'signup', false]]);
  });

  it('adds no account pages for a site without accounts', () => {
    assert.ok(planBuild(plan({ pages: [page('index.html', 'Home')] })).pages.every((p) => p.role !== 'login' && p.role !== 'signup'));
  });

  it('sends visitors to the dashboard after signing in, else home', () => {
    const app = planBuild(plan({ kind: 'app', pages: [page('index.html', 'Home'), page('dashboard.html', 'Dashboard')], backend: { auth: true } }));
    assert.equal(app.afterLogin, 'dashboard.html');
    assert.equal(planBuild(plan({ pages: [page('index.html', 'Home')], backend: { auth: true } })).afterLogin, 'index.html');
  });

  it('caps the page count but never drops the home or account pages', () => {
    const many = Array.from({ length: 25 }, (_, i) => page(`p${i}.html`, `Page ${i}`));
    const s = planBuild(plan({ pages: [page('index.html', 'Home'), ...many], backend: { auth: true } }));
    assert.equal(s.pages.length, MAX_BUILD_PAGES);
    assert.ok(s.pages.some((p) => p.role === 'home') && s.pages.some((p) => p.role === 'login') && s.pages.some((p) => p.role === 'signup'));
    assert.ok(s.open_items.some((i) => /pages/.test(i)));
  });

  it('keeps the account pages out of the main menu', () => {
    const s = planBuild(plan({ pages: [page('index.html', 'Home'), page('about.html', 'About')], backend: { auth: true } }));
    assert.deepEqual(navPages(s).map((p) => p.file), ['index.html', 'about.html']);
  });
});

describe('planBuild — forms', () => {
  const pages = [page('index.html', 'Home'), page('about.html', 'About', 'Our story'), page('contact.html', 'Contact', 'Get in touch')];

  it('puts a contact form on the contact page and a waitlist on the home page', () => {
    const s = planBuild(plan({ pages, backend: { forms: ['contact', 'waitlist'] } }));
    assert.deepEqual(s.pages.find((p) => p.file === 'contact.html')!.forms, ['contact']);
    assert.deepEqual(s.pages.find((p) => p.file === 'index.html')!.forms, ['waitlist']);
    assert.deepEqual(s.formIds, ['contact', 'waitlist']);
  });

  it('gives every form exactly one home, never an account page', () => {
    const s = planBuild(plan({ pages: [page('index.html', 'Home')], backend: { auth: true, forms: ['feedback', 'newsletter'] } }));
    const hosts = s.pages.flatMap((p) => p.forms.map((f) => [p.file, f]));
    assert.deepEqual(hosts.map((h) => h[1]).sort(), ['feedback', 'newsletter']);
    assert.ok(hosts.every((h) => h[0] === 'index.html'));
  });

  it('matches a form to the page it is named after', () => {
    const s = planBuild(plan({ pages: [page('index.html', 'Home'), page('booking.html', 'Book a table')], backend: { forms: ['booking'] } }));
    assert.deepEqual(s.pages.find((p) => p.file === 'booking.html')!.forms, ['booking']);
  });

  it('treats collections as data stores (hosted, but not required to be forms) and drops reserved or invalid names', () => {
    const s = planBuild(plan({ pages, backend: { forms: ['contact'], collections: ['notes', 'transactions', '', 'contact', '!!!'] } }));
    assert.deepEqual(s.forms, ['contact', 'notes']);
    assert.deepEqual(s.formIds, ['contact']);
  });
});

describe('planBuild — products', () => {
  const item = (name: string, price_cents: number, interval?: 'month' | 'year') => ({ name, price_cents, ...(interval ? { interval } : {}) });

  it('pairs named products with their prices and makes one-time prices sellable', () => {
    const s = planBuild(plan({
      pages: [page('index.html', 'Home'), page('shop.html', 'Shop')],
      pricing: { model: 'one_time', items: [item('Soy Candle', 2400), item('Wooden Wick Trimmer', 1800)] },
      backend: { products: ['soy-candle', 'wick-trimmer'] },
    }));
    assert.deepEqual(s.products.map((p) => [p.id, p.price_cents, p.sellable]), [['soy-candle', 2400, true], ['wick-trimmer', 1800, true]]);
    assert.deepEqual(s.pages.find((p) => p.file === 'shop.html')!.products, ['soy-candle', 'wick-trimmer']);
    assert.deepEqual(s.open_items, []);
  });

  it('sells a product on the shop, not on the home page whose purpose line merely mentions it — unless a file or title names it', () => {
    const base = { pricing: { model: 'one_time' as const, items: [{ name: 'Candle', price_cents: 2400 }, { name: 'Soap', price_cents: 900 }] }, backend: { products: ['candle', 'soap'] } };
    const a = planBuild(plan({ ...base, pages: [page('index.html', 'Home', 'Introduce the candles and soaps'), page('shop.html', 'Shop', 'Buy things')] }));
    assert.deepEqual(a.pages.map((p) => p.products), [[], ['candle', 'soap']]);
    const b = planBuild(plan({ ...base, pages: [page('index.html', 'Home', ''), page('candles.html', 'Candles', ''), page('shop.html', 'Shop', '')] }));
    assert.deepEqual(b.pages.map((p) => p.products), [[], ['candle'], ['soap']]);
  });

  it('pairs a single product with a single price even when the names differ', () => {
    const s = planBuild(plan({ pricing: { model: 'one_time', items: [item('Standard', 3000)] }, backend: { products: ['candle'] } }));
    assert.deepEqual(s.products.map((p) => [p.id, p.price_cents, p.sellable]), [['candle', 3000, true]]);
  });

  it('turns stated one-time prices into products when the plan names none', () => {
    const s = planBuild(plan({ pricing: { model: 'one_time', items: [item('Starter kit', 4900)] } }));
    assert.deepEqual(s.products.map((p) => [p.id, p.sellable]), [['starter-kit', true]]);
  });

  it('never invents a price: a named product without one is unsold and goes on the open list', () => {
    const s = planBuild(plan({ backend: { products: ['tote-bag'] } }));
    assert.deepEqual(s.products, [{ id: 'tote-bag', name: 'tote-bag', price_cents: null, sellable: false }]);
    assert.match(s.open_items.join('\n'), /Set a price for "tote-bag"/);
  });

  it('shows a recurring price but does not sell it online, and says so', () => {
    const s = planBuild(plan({ pricing: { model: 'subscription', items: [item('Monthly box', 3500, 'month')] } }));
    assert.deepEqual(s.products.map((p) => [p.id, p.price_cents, p.interval, p.sellable]), [['monthly-box', 3500, 'month', false]]);
    assert.match(s.open_items.join('\n'), /monthly price/);
  });

  it('will not sell below the 50 cent card minimum', () => {
    const s = planBuild(plan({ pricing: { model: 'one_time', items: [item('Sticker', 25)] } }));
    assert.equal(s.products[0]!.sellable, false);
    assert.match(s.open_items.join('\n'), /under \$0\.50/);
  });

  it('does not sell anything on a free, quote or no-pricing plan', () => {
    for (const model of ['free', 'quote', 'none'] as const) assert.deepEqual(planBuild(plan({ pricing: { model, items: [] } })).products, []);
  });

  it('gives duplicate product names distinct ids', () => {
    const s = planBuild(plan({ pricing: { model: 'one_time', items: [item('Mug', 1500), item('Mug', 1700)] } }));
    assert.deepEqual(s.products.map((p) => p.id), ['mug', 'mug-2']);
  });
});

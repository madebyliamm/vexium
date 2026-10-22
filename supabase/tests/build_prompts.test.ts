// FULL BUILD prompts — run:  node --test supabase/tests/build_prompts.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../functions/_shared/artifacts.ts';
import { planBuild } from '../functions/ai-chat/build-plan.ts';
import { BUILD_BRIEF, BUILD_DEFAULT_MESSAGE, buildSystem, fixPrompt, pageFromReply, pagePrompt, WORKING_PARTS, type BuildContext } from '../functions/ai-chat/build-prompts.ts';
import { EXAMPLE_CSS, STYLE } from './site_fixtures.ts';

function plan(patch: Partial<Plan> = {}): Plan {
  return {
    ...emptyPlan('Wick & Co'),
    one_liner: 'Hand-poured candles',
    audience: 'People who like a quiet home',
    pages: [{ file: 'index.html', title: 'Home', purpose: 'Introduce the candles' }, { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' }, { file: 'contact.html', title: 'Contact', purpose: 'Get in touch' }],
    pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2400 }, { name: 'Club', price_cents: 900, interval: 'month' }] },
    backend: { collections: [], products: ['candle', 'club'], forms: ['contact'], auth: false },
    ...patch,
  };
}
function ctx(p: Plan = plan(), over: Partial<BuildContext> = {}): BuildContext {
  return { plan: p, style: STYLE, spec: planBuild(p), versions: { plan: 3, style_spec: 2 }, stylesCss: EXAMPLE_CSS, example: '<!DOCTYPE html><html><body><h1>Example landing</h1></body></html>', images: [], ...over };
}
const page = (c: BuildContext, file: string) => c.spec.pages.find((p) => p.file === file)!;

describe('buildSystem — the cached block', () => {
  const c = ctx();
  const sys = buildSystem(c);
  it('holds the stage rules, the shared rules, the plan, the locked style, the site map, the stylesheet and the example page', () => {
    for (const s of [BUILD_BRIEF, WORKING_PARTS, 'SHARED-FILE RULES', 'REAL CONTENT ONLY', 'opacity:0 IS COMPLETELY BANNED', '<frontend-craft>', '### plan (version 3)', '### style_spec (version 2, locked)', 'Wick & Co', '=== styles.css ===', '--accent: #00ff00', '=== index.html (example) ===', 'Example landing', 'Never invent facts']) {
      assert.ok(sys.includes(s), s.slice(0, 40));
    }
    assert.match(sys, /SITE MAP[^\n]*\n- index\.html — Home \(home page\): Introduce the candles\n- shop\.html — Shop: Buy a candle\n- contact\.html — Contact: Get in touch/);
    assert.match(sys, /no accounts/);
  });
  it('is byte-identical for every page of the build — the cache is shared (nothing about a page leaks in)', () => {
    assert.equal(buildSystem(ctx()), sys);
    assert.ok(!sys.includes('PAGE TO BUILD:'));
    assert.ok(!sys.includes('REPAIR'));
  });
  it('does not depend on the key order of the stored plan', () => {
    const p = plan();
    const shuffled = Object.fromEntries(Object.entries(p).reverse()) as unknown as Plan;
    assert.equal(buildSystem(ctx(shuffled, { spec: c.spec })), sys);
  });
  it('says what accounts exist and where signing in leads; lists the project\'s own images', () => {
    const a = ctx(plan({ backend: { collections: [], products: [], forms: [], auth: true } }), { images: ['logo.png', 'candle.jpg'] });
    const s = buildSystem(a);
    assert.match(s, /has ACCOUNTS[^\n]*sends them to index\.html/);
    assert.match(s, /login\.html — Log in \(log in\)/);
    assert.match(s, /PROJECT IMAGE FILES \(real, usable by file name\): logo\.png, candle\.jpg/);
    assert.match(sys, /PROJECT IMAGE FILES: none/);
  });
  it('copes with no example page, and trims a huge one', () => {
    assert.match(buildSystem(ctx(plan(), { example: null })), /There is no example page to match/);
    const big = buildSystem(ctx(plan(), { example: `<html>${'x'.repeat(100_000)}</html>` }));
    assert.match(big, /cut here: \d+ more characters/);
    assert.ok(big.length < 400_000);
  });
});

describe('the rules the build must carry', () => {
  it('the page is the only thing the AI writes, in one file block, with nothing around it', () => {
    assert.match(BUILD_BRIEF, /each writes ONE page/);
    assert.match(BUILD_BRIEF, /Never write it, and never write nav or footer markup/);
    assert.match(buildSystem(ctx()), /Write the page as <file name="PAGE\.html"> … <\/file>[\s\S]*no chat before or after the file/);
  });
  it('prices only from the plan, buy buttons only for listed products, no outside images, closed pages', () => {
    assert.match(BUILD_BRIEF, /the only prices you may write are the ones in the plan's pricing items/);
    assert.match(BUILD_BRIEF, /With no prices in the plan, write none/);
    assert.match(BUILD_BRIEF, /never an outside image address/);
    assert.match(BUILD_BRIEF, /A page that is cut off breaks the whole site/);
    assert.match(WORKING_PARTS, /for the products listed under PRODUCTS only/);
  });
  it('documents every hook the verifier checks for', () => {
    for (const h of ['data-vx-form', 'data-vx-success', 'data-vx-message', 'data-vx-auth', 'data-vx-redirect', 'data-vx-logout', 'data-vx-require-auth', 'data-vx-skip-if-auth', 'data-vx-show', 'data-vx-user', 'data-vx-buy', 'data-vx-paid', 'data-vx-buy-amount', 'vx.data.submit', 'vx.data.list']) assert.ok(WORKING_PARTS.includes(h), h);
  });
});

describe('pagePrompt', () => {
  const c = ctx();
  it('names the page and what it must achieve; the home page starts from the example', () => {
    const p = pagePrompt(c, page(c, 'index.html'));
    assert.match(p, /PAGE TO BUILD: index\.html\nTitle: Home\nPurpose: Introduce the candles/);
    assert.match(p, /Start from the APPROVED EXAMPLE PAGE/);
    assert.match(p, /do not add a form, a sign-up box or a buy button/);
    assert.match(p, /Write index\.html now/);
  });
  it('tells a page which form it hosts, and a page without one not to invent a form', () => {
    assert.match(pagePrompt(c, page(c, 'contact.html')), /FORM "contact" lives on this page, and only here: <form data-vx-form="contact">/);
    assert.doesNotMatch(pagePrompt(c, page(c, 'shop.html')), /FORM "/);
  });
  it('gives a selling page its products with exact ids and prices, and shows an unsellable one without a buy button', () => {
    const p = pagePrompt(c, page(c, 'shop.html'));
    assert.match(p, /id "candle": candle — \$24, one time → <button data-vx-buy="candle">/);
    assert.match(p, /"club": show it without a buy button \(it is a recurring price, which has no online checkout yet\), price \$9\/month/);
  });
  it('log-in and sign-up pages carry the account forms and where signing in leads', () => {
    const a = ctx(plan({ backend: { collections: [], products: [], forms: [], auth: true } }));
    const login = pagePrompt(a, page(a, 'login.html'));
    assert.match(login, /<form data-vx-auth="login" data-vx-redirect="index\.html">/);
    assert.match(login, /link to signup\.html/);
    assert.match(login, /data-vx-skip-if-auth="index\.html"/);
    assert.match(pagePrompt(a, page(a, 'signup.html')), /<form data-vx-auth="signup" data-vx-redirect="index\.html">[\s\S]*link to login\.html/);
  });
  it('an app\'s inner pages are sign-in only; a site\'s only when they show personal information', () => {
    const app = ctx(plan({ kind: 'app', pages: [{ file: 'index.html', title: 'Home', purpose: '' }, { file: 'dashboard.html', title: 'Dashboard', purpose: 'Your tasks' }], pricing: { model: 'free', items: [] }, backend: { collections: ['tasks'], products: [], forms: [], auth: true } }));
    assert.match(pagePrompt(app, page(app, 'dashboard.html')), /every page except the home, log-in and sign-up pages is for signed-in visitors, so put data-vx-require-auth="login\.html"/);
    assert.match(pagePrompt(app, page(app, 'dashboard.html')), /data store called "tasks"|"tasks"/);
    const site = ctx(plan({ backend: { collections: [], products: [], forms: [], auth: true } }));
    assert.match(pagePrompt(site, page(site, 'shop.html')), /only if this page shows a visitor's own information/);
  });
  it('carries the owner\'s note, but not the studio\'s default message', () => {
    assert.match(pagePrompt(c, page(c, 'index.html'), { note: 'Make the about page warmer.' }), /OWNER'S NOTE FOR THIS BUILD[^\n]*\nMake the about page warmer\./);
    assert.doesNotMatch(pagePrompt(c, page(c, 'index.html'), { note: BUILD_DEFAULT_MESSAGE }), /OWNER'S NOTE/);
    assert.doesNotMatch(pagePrompt(c, page(c, 'index.html'), { note: '   ' }), /OWNER'S NOTE/);
  });
});

describe('fixPrompt', () => {
  const c = ctx();
  const html = '<!DOCTYPE html><html><body><h1>Shop</h1><a href="#">x</a></body></html>';
  const problems = [{ check: 'links', message: 'The link "x" goes nowhere.' }, { check: 'content', message: 'The page contains lorem ipsum filler text.' }];
  it('repeats the page\'s assignment, lists every problem, and includes the page as it is', () => {
    const p = fixPrompt(c, page(c, 'shop.html'), html, problems);
    assert.match(p, /PAGE TO BUILD: shop\.html/);
    assert.match(p, /REPAIR\nThe page below was checked[\s\S]*1\. The link "x" goes nowhere\.\n2\. The page contains lorem ipsum filler text\./);
    assert.match(p, /=== shop\.html ===\n<!DOCTYPE html>[\s\S]*=== end of shop\.html ===/);
    assert.doesNotMatch(p, /SHORTER/);
  });
  it('asks for a shorter page when the page was cut off', () => {
    assert.match(fixPrompt(c, page(c, 'shop.html'), html.replace('</html>', ''), problems), /write a SHORTER page/);
  });
  it('rebuilds from scratch when there is no page at all', () => {
    const p = fixPrompt(c, page(c, 'shop.html'), null, [{ check: 'pages', message: 'This page could not be built: no reply.' }]);
    assert.match(p, /nothing to repair: write the whole page afresh/);
    assert.match(p, /no reply/);
    assert.doesNotMatch(p, /THE PAGE AS IT IS NOW/);
  });
  it('shares nothing per-call with the cached block', () => {
    assert.ok(!buildSystem(c).includes(fixPrompt(c, page(c, 'shop.html'), html, problems).trim().slice(0, 40)));
  });
});

describe('pageFromReply', () => {
  const html = `<!DOCTYPE html><html><body>${'<p>real content</p>'.repeat(20)}</body></html>`;
  it('takes the file with the page\'s name (any case, with or without ./) and ignores files it should not have written', () => {
    assert.deepEqual(pageFromReply('shop.html', { 'shop.html': html, 'styles.css': 'body{}' }), { html });
    assert.deepEqual(pageFromReply('shop.html', { './Shop.html': html }), { html });
  });
  it('refuses a reply that wrote another page, an empty page or an enormous one', () => {
    assert.match((pageFromReply('shop.html', { 'index.html': html }) as { error: string }).error, /did not write shop\.html/);
    assert.match((pageFromReply('shop.html', { 'shop.html': '<html></html>' }) as { error: string }).error, /empty/);
    assert.match((pageFromReply('shop.html', { 'shop.html': 'x'.repeat(300_001) }) as { error: string }).error, /too long/);
    assert.match((pageFromReply('shop.html', {}) as { error: string }).error, /did not write/);
  });
});

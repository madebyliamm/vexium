// The Anthropic stand-in used for live Workflow tests — run:  node --test cf-worker/test/mock_anthropic.test.ts
// Its pages are written from the REAL build prompts and must pass the REAL launch verifier, or the live run would test the mock instead of the build.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPlan, type Plan } from '../../supabase/functions/_shared/artifacts.ts';
import { buildSystem, fixPrompt, pagePrompt, pageFromReply } from '../../supabase/functions/ai-chat/build-prompts.ts';
import { planBuild } from '../../supabase/functions/ai-chat/build-plan.ts';
import { assembleSite, finishStylesheet } from '../../supabase/functions/ai-chat/site-derive.ts';
import { verifySite } from '../../supabase/functions/ai-chat/verifier.ts';
import { EXAMPLE_CSS, HOME, STYLE } from '../../supabase/tests/site_fixtures.ts';
import mock, { pageFor } from '../mock/anthropic.ts';
import { callModel } from '../model.ts';

const SHOP_PLAN: Plan = {
  ...emptyPlan('Wick & Co'),
  one_liner: 'Hand-poured candles',
  pages: [
    { file: 'index.html', title: 'Home', purpose: 'Introduce the candles' },
    { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' },
    { file: 'contact.html', title: 'Contact', purpose: 'Get in touch' },
  ],
  pricing: { model: 'one_time', items: [{ name: 'Amber candle', price_cents: 2400 }] },
  backend: { collections: [], products: ['Amber candle'], forms: ['contact'], auth: false },
};
const ACCOUNT_PLAN: Plan = {
  ...SHOP_PLAN,
  kind: 'app',
  pages: [...SHOP_PLAN.pages, { file: 'account.html', title: 'Account', purpose: 'Your orders' }],
  backend: { ...SHOP_PLAN.backend, auth: true },
};

function context(plan: Plan) {
  const spec = planBuild(plan);
  const stylesCss = finishStylesheet(EXAMPLE_CSS, STYLE);
  return { plan, style: STYLE, spec, versions: { plan: 1, style_spec: 1 }, stylesCss, example: HOME, images: [] as string[] };
}

function mockSite(plan: Plan) {
  const c = context(plan);
  const system = buildSystem(c);
  const pages: Record<string, string> = {};
  for (const p of c.spec.pages) {
    const made = pageFor(system, pagePrompt(c, p));
    assert.ok(made, `the mock wrote nothing for ${p.file}`);
    assert.equal(made.file, p.file);
    const reply = pageFromReply(p.file, { [p.file]: made.html });
    assert.ok('html' in reply, JSON.stringify(reply));
    pages[p.file] = reply.html;
  }
  const a = assembleSite({ plan, spec: c.spec, style: STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS }, pages });
  return { c, system, pages, files: { ...a.files }, result: verifySite({ plan, spec: c.spec, style: STYLE, files: a.files }) };
}

describe('mock Anthropic, against the real prompts and verifier', () => {
  for (const [name, plan] of [['a shop with a contact form', SHOP_PLAN], ['an app with accounts', ACCOUNT_PLAN]] as const) {
    it(`builds ${name} that passes every launch check`, () => {
      const { result, files } = mockSite(plan);
      assert.deepEqual(result.problems.filter((p) => p.severity === 'fail'), []);
      assert.equal(result.ok, true);
      assert.ok(files['_backend']);
    });
  }
  it('hosts what the platform assigned: the product on the shop page, the form on the contact page, sign-in forms on the account pages', () => {
    const s = mockSite(ACCOUNT_PLAN);
    assert.match(s.pages['shop.html']!, /data-vx-buy="amber-candle"/);
    assert.match(s.pages['contact.html']!, /data-vx-form="contact"/);
    assert.match(s.pages['login.html']!, /data-vx-auth="login"/);
    assert.match(s.pages['signup.html']!, /data-vx-auth="signup"/);
    assert.match(s.pages['account.html']!, /data-vx-require-auth="login\.html"/);
  });
  it('"mock-flaw" in a purpose breaks the first attempt (a dead link the verifier catches) and the repair call fixes it', () => {
    const plan: Plan = { ...SHOP_PLAN, pages: SHOP_PLAN.pages.map((p) => (p.file === 'contact.html' ? { ...p, purpose: `${p.purpose} mock-flaw` } : p)) };
    const c = context(plan);
    const contact = c.spec.pages.find((p) => p.file === 'contact.html')!;
    const system = buildSystem(c);
    const attempt = (prompt: string) => pageFor(system, prompt)!.html;
    const check = (contactHtml: string) => {
      const pages: Record<string, string> = {};
      for (const p of c.spec.pages) pages[p.file] = p.file === 'contact.html' ? contactHtml : pageFor(system, pagePrompt(c, p))!.html;
      const a = assembleSite({ plan, spec: c.spec, style: STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS }, pages });
      return verifySite({ plan, spec: c.spec, style: STYLE, files: a.files });
    };
    const first = attempt(pagePrompt(c, contact));
    assert.match(first, /missing-page\.html/);
    assert.equal(check(first).ok, false);
    assert.ok(check(first).problems.some((p) => p.check === 'links' && p.file === 'contact.html'));
    const fixed = attempt(fixPrompt(c, contact, first, [{ check: 'links', message: 'dead link' }]));
    assert.ok(!fixed.includes('missing-page.html'));
    assert.equal(check(fixed).ok, true);
  });
  it('answers like the API: the build Worker\'s own model client reads the page and the usage back', async () => {
    const c = context(SHOP_PLAN);
    const shop = c.spec.pages.find((p) => p.file === 'shop.html')!;
    const doFetch = ((url: string, init: RequestInit) => mock.fetch(new Request(url, init))) as unknown as typeof fetch;
    const r = await callModel(
      { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://mock.test' },
      { model: 'm', max_tokens: 5000, system: buildSystem(c), prompt: pagePrompt(c, shop) },
      new AbortController().signal,
      doFetch,
    );
    assert.deepEqual(Object.keys(r.files), ['shop.html']);
    assert.match(r.files['shop.html']!, /^\s*<!DOCTYPE html>/);
    assert.ok(r.usage.out > 50 && r.usage.cacheRead > 0, JSON.stringify(r.usage));
  });
});

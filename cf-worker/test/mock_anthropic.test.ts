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
import mock, { pageFor, partnerFor, tweakFor } from '../mock/anthropic.ts';
import { factsOf, groundAdvice, parseReply, partnerPrompt } from '../../supabase/functions/_shared/advice.ts';
import { buildBusinessState, type RawStats } from '../../supabase/functions/_shared/business.ts';
import { makeParse, processStreamBlock } from '../core.ts';
import { buildStagePrompt } from '../../supabase/functions/ai-chat/stages.ts';
import { finishTweaks } from '../../supabase/functions/ai-chat/tweaks.ts';
import { cleanPointed, tweakContext } from '../../supabase/functions/ai-chat/tweaks-prompt.ts';
import { builtSite, latestOf, PLAN as BUILT_PLAN } from '../../supabase/tests/built_site.ts';
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

describe('mock Anthropic answers tweak prompts', () => {
  const site = builtSite();
  const latest = latestOf(site.manifest);
  const pointed = cleanPointed({ page: 'index.html', selector: 'main > section.hero > h1', tag: 'h1', text: 'Candles poured by hand', html: '<h1>Candles poured by hand</h1>' }) as NonNullable<ReturnType<typeof cleanPointed>> & object;
  const prompt = buildStagePrompt('tweaks', latest, { projectName: 'Wick & Co', extra: tweakContext({ files: site.files, pages: BUILT_PLAN.pages, pointed }).text });
  const system = prompt.system + prompt.suffix;

  /** The reply, through the build Worker's own patch parser, to the final text of every file it touched. */
  function patched(reply: string): { written: Record<string, string>; failed: number } {
    const state = makeParse({ ...site.files });
    const written: Record<string, string> = {};
    let failed = 0;
    for (const ev of processStreamBlock(reply, state)) {
      if (ev.type === 'patch_done' && ev.encoding === 'base64') written[ev.name!] = Buffer.from(ev.content!, 'base64').toString('utf8');
      if (ev.type === 'patch_done' && ev.encoding === 'failed') failed++;
    }
    return { written, failed };
  }
  const judge = (reply: string) => {
    const r = patched(reply);
    return finishTweaks({ message: 'm', written: r.written, patchFailed: r.failed, files: site.files, latest });
  };

  it('only answers the tweak prompt', () => {
    assert.equal(tweakFor('STAGE: PLAN', 'mock-say "x"'), null);
  });
  it('"mock-say" changes the words of the element that was pointed at', () => {
    const r = judge(tweakFor(system, 'mock-say "Candles poured with care"')!);
    assert.equal(r.error, undefined);
    assert.match(r.files['index.html']!, /Candles poured with care/);
    assert.ok(!r.files['index.html']!.includes('Candles poured by hand'));
  });
  it('"mock-say" anchors on the pointed element, so the same words in the title and the menu are left alone', () => {
    const html = '<html><head><title>Candles</title></head><body><nav><a href="index.html">Candles</a></nav><h1>Candles</h1></body></html>';
    const sys = `STAGE: TWEAKS\nTHE OWNER POINTED AT THIS ELEMENT in the preview of index.html. x\n- element: <h1>\n- its visible text: "Candles"\n=== index.html ===\n${html}\n=== end of index.html ===`;
    const state = makeParse({ 'index.html': html });
    let out = '';
    for (const ev of processStreamBlock(tweakFor(sys, 'mock-say "Hand-poured"')!, state)) if (ev.type === 'patch_done' && ev.encoding === 'base64') out = Buffer.from(ev.content!, 'base64').toString('utf8');
    assert.equal(out, '<html><head><title>Candles</title></head><body><nav><a href="index.html">Candles</a></nav><h1>Hand-poured</h1></body></html>');
  });
  it('"mock-accent" moves the accent token: a new locked style comes with it', () => {
    const r = judge(tweakFor(system, 'make the accent mock-accent #2f7d4f')!);
    assert.equal(r.error, undefined);
    assert.equal(r.style?.tokens['--accent'], '#2f7d4f');
    assert.equal(r.style?.locked, true);
  });
  it('"mock-bad-find" is a patch that matches nothing: the whole change is thrown away', () => {
    const r = judge(tweakFor(system, 'mock-bad-find')!);
    assert.match(r.error!, /none of it was made/);
  });
  it('"mock-hook" renames a form field: refused, forms are set up in the Plan', () => {
    assert.match(judge(tweakFor(system, 'mock-hook')!).error!, /form, a sign-in box or a buy button/);
  });
  it('anything else is a question and no edit', () => {
    const r = judge(tweakFor(system, 'make it nicer')!);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.files, {});
  });
  it('over the wire, a tweak request gets the patch reply (the owner\'s LAST message steers it)', async () => {
    const body = { model: 'm', max_tokens: 100, stream: true, system: [{ type: 'text', text: prompt.system }, { type: 'text', text: prompt.suffix }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'mock-accent #2f7d4f' }] };
    const res = await mock.fetch(new Request('https://mock.test/v1/messages', { method: 'POST', body: JSON.stringify(body) }));
    const text = await res.text();
    assert.match(text, /patch name=\\"styles\.css\\"/);
    assert.match(text, /--accent: #2f7d4f/);
  });
});

describe('mock model — BUSINESS PARTNER', () => {
  const stats: RawStats = {
    days: 30,
    traffic: { views: 400, visitors: 120, prev_visitors: 80, sources: [{ source: 'www.google.com', visitors: 60 }], pages: [{ page: '/', views: 250, visitors: 110 }] },
    money: { current: [{ currency: 'usd', orders: 5, gross_cents: 12500, refunds_cents: 0, net_cents: 12500 }], previous: [], products: [] },
    lifetime: { views: 900, first_view_at: '2026-09-01T00:00:00Z', orders: 12, signups: 0, leads: 0 },
  };
  const facts = factsOf(buildBusinessState({ stats, now: new Date('2026-10-24T12:00:00Z'), firstLiveAt: new Date('2026-09-01T00:00:00Z') }));
  const promptFor = (name: string) => partnerPrompt({ name, plan: null, manifest: null, facts }).system;

  it('only answers the partner prompt', () => {
    assert.equal(partnerFor('STAGE: PLAN'), null);
  });
  it('its default reply survives the platform\'s grounding rules (real numbers, real fact ids)', () => {
    const g = groundAdvice(parseReply(partnerFor(promptFor('Beanery'))!), facts);
    assert.deepEqual(g.dropped, []);
    assert.deepEqual(g.recommendations.map((r) => r.id), ['stand-out', 'share-more']);
    assert.match(g.recommendations[0]!.apply!, /mock-accent #b45309/);
    assert.match(g.recommendations[0]!.why, /120 visitors and 5 orders/);
  });
  it('"mock-invent" in the name adds a recommendation the platform must drop', () => {
    const g = groundAdvice(parseReply(partnerFor(promptFor('Beanery mock-invent'))!), facts);
    assert.deepEqual(g.recommendations.map((r) => r.id), ['stand-out', 'share-more']);
    assert.equal(g.dropped.length, 1);
  });
  it('"mock-nojson" answers in prose', () => {
    assert.equal(parseReply(partnerFor(promptFor('Beanery mock-nojson'))!), null);
  });
  it('over HTTP without streaming it returns the plain JSON message the edge function reads', async () => {
    const res = await mock.fetch(new Request('https://mock/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'x', system: promptFor('Beanery'), messages: [{ role: 'user', content: 'Here is how my business is doing.' }] }) }));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.content[0].type, 'text');
    assert.ok(parseReply(out.content[0].text));
    assert.ok(out.usage.input_tokens > 0 && out.usage.output_tokens > 0);
  });
  it('"mock-credit" in the name answers like an account without credit', async () => {
    const res = await mock.fetch(new Request('https://mock/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'x', system: promptFor('Beanery mock-credit'), messages: [{ role: 'user', content: 'hi' }] }) }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /credit balance/);
  });
});

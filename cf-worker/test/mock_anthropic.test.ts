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
import mock, { pageFor, tweakFor } from '../mock/anthropic.ts';
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARTIFACT_OPEN } from '../../supabase/functions/ai-chat/stages.ts';
import {
  ARTIFACT_MARK, MAX_HISTORY, addChecklistItem, addPage, addPriceItem, canRetry, centsToInput, cleanFileName, describeProblem, planProblems, formatMoney, historyToSend, inputToCents, parseNameList,
  planHints, readPlan, removeChecklistItem, removePage, removePriceItem, samePlan, scenarioMonthlyCents, setAuth, setBackendList, setNotes, setPricingModel,
  setScenario, setText, splitLiveReply, startScenario, syncedName, toChatLine, toggleChecklistItem, updatePage, updatePriceItem, type ChatLine,
} from '../src/lib/plan-view.ts';
import { emptyPlan, validateArtifact } from '../src/types/artifacts.ts';

const priced = () => updatePriceItem(addPriceItem(emptyPlan('Bean There')), 0, { name: 'Monthly bag', price_cents: 1800, interval: 'month' });

describe('readPlan', () => {
  it('returns a valid empty plan for anything that is not an object', () => {
    for (const bad of [null, undefined, 'x', 5, [1]]) {
      const p = readPlan(bad, 'Mine');
      assert.equal(p.name, 'Mine');
      assert.equal(validateArtifact('plan', p).ok, true);
    }
  });

  it('keeps a good plan exactly as it is', () => {
    const plan = { ...priced(), one_liner: 'Coffee', audience: 'Home brewers', offer: 'A bag a month', notes: 'Assumed monthly', scenario: { price_cents: 1800, monthly_visitors: 500, conversion_pct: 3 } };
    assert.ok(samePlan(readPlan(plan), plan));
  });

  it('repairs missing or malformed parts instead of throwing', () => {
    const p = readPlan({ name: 5, kind: 'weird', pricing: { model: 'barter', items: [{ name: 'a', price_cents: -4.6 }, 'junk'] }, pages: 'x', backend: { forms: ['a', 3], auth: 'yes' }, launch_checklist: [{ id: 'a', label: 'L', type: 'zzz', done: 1 }], scenario: 'no' });
    assert.equal(p.name, 'Untitled');
    assert.equal(p.kind, 'site');
    assert.equal(p.pricing.model, 'none');
    assert.deepEqual(p.pricing.items, [{ name: 'a', price_cents: 0 }]);
    assert.deepEqual(p.backend, { collections: [], products: [], forms: ['a'], auth: false });
    assert.deepEqual(p.launch_checklist, [{ id: 'a', label: 'L', type: 'other', done: false }]);
    assert.equal(p.scenario, null);
    assert.equal(p.pages.length, 1, 'a plan with a broken page list gets the default home page');
  });

  it('keeps unknown extra keys (a later version may add fields)', () => {
    assert.equal((readPlan({ ...emptyPlan('A'), future: { x: 1 } }) as unknown as { future: unknown }).future !== undefined, true);
  });
});

describe('samePlan', () => {
  it('ignores key order but notices every real change', () => {
    const a = priced();
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(a) as typeof a;
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(a), 'the fixture really has a different key order');
    assert.ok(samePlan(a, reordered));
    assert.ok(!samePlan(a, setText(a, 'name', 'Other')));
    assert.ok(!samePlan(a, setNotes(a, 'x')));
  });
});

describe('draft edits', () => {
  it('never change the plan they were given', () => {
    const before = JSON.stringify(priced());
    const p = priced();
    setText(p, 'name', 'X'); addPage(p); addChecklistItem(p, 'Photos'); removePriceItem(p, 0); setScenario(p, { price_cents: 5 });
    assert.equal(JSON.stringify(p), before);
  });

  it('text, notes, pricing model, auth', () => {
    let p = setText(emptyPlan('A'), 'one_liner', 'Hello');
    assert.equal(p.one_liner, 'Hello');
    p = setNotes(p, 'Assumed X');
    assert.equal(p.notes, 'Assumed X');
    assert.ok(!('notes' in setNotes(p, '')), 'an empty note is dropped, not saved as ""');
    assert.equal(setPricingModel(p, 'subscription').pricing.model, 'subscription');
    assert.equal(setAuth(p, true).backend.auth, true);
  });

  it('price items: add, edit, remove (an interval can be cleared)', () => {
    let p = priced();
    assert.deepEqual(p.pricing.items, [{ name: 'Monthly bag', price_cents: 1800, interval: 'month' }]);
    p = updatePriceItem(p, 0, { interval: undefined });
    assert.ok(!('interval' in p.pricing.items[0]!));
    p = removePriceItem(addPriceItem(p), 0);
    assert.deepEqual(p.pricing.items, [{ name: '', price_cents: 0 }]);
  });

  it('pages get fresh file names and can be edited and removed', () => {
    let p = addPage(addPage(emptyPlan('A')));
    assert.deepEqual(p.pages.map((x) => x.file), ['index.html', 'page-2.html', 'page-3.html']);
    p = updatePage(p, 1, { file: 'about.html', title: 'About' });
    assert.deepEqual(p.pages[1], { file: 'about.html', title: 'About', purpose: '' });
    assert.deepEqual(removePage(p, 0).pages.map((x) => x.file), ['about.html', 'page-3.html']);
  });

  it('checklist: add (trimmed, unique ids), toggle, remove; blank labels are ignored', () => {
    let p = addChecklistItem(addChecklistItem(emptyPlan('A'), '  Real photos '), 'Privacy policy');
    assert.deepEqual(p.launch_checklist.map((c) => [c.id, c.label, c.done]), [['item-1', 'Real photos', false], ['item-2', 'Privacy policy', false]]);
    assert.equal(addChecklistItem(p, '   '), p);
    p = toggleChecklistItem(p, 'item-2');
    assert.equal(p.launch_checklist[1]!.done, true);
    p = removeChecklistItem(p, 'item-1');
    assert.equal(addChecklistItem(p, 'Domain').launch_checklist[1]!.id, 'item-3', 'a new id never repeats an existing one');
  });

  it('backend lists come from comma-separated text', () => {
    assert.deepEqual(parseNameList(' forms, newsletter ,, forms '), ['forms', 'newsletter']);
    assert.deepEqual(parseNameList(''), []);
    assert.deepEqual(setBackendList(emptyPlan('A'), 'forms', ['contact']).backend.forms, ['contact']);
  });

  it('every edit leaves a plan the server accepts (when the plan was valid)', () => {
    let p = priced();
    p = setScenario(p, startScenario(p));
    p = addChecklistItem(updatePage(addPage(setNotes(setText(p, 'audience', 'Home brewers'), 'Assumed')), 1, { title: 'About' }), 'Photos');
    assert.deepEqual(validateArtifact('plan', p), { ok: true, value: p });
  });

  it('a page or price that is still blank is something the server refuses — the screen has to say so before saving', () => {
    const blankPage = addPage(emptyPlan('A'));
    const r = validateArtifact('plan', blankPage);
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('pages[1].title')));
    const blankPrice = addPriceItem(emptyPlan('A'));
    const r2 = validateArtifact('plan', blankPrice);
    assert.ok(!r2.ok && r2.errors.some((e) => e.startsWith('pricing.items[0].name')));
  });
});

describe('revenue what-if', () => {
  it('is visitors × conversion × price, in cents, rounded', () => {
    assert.equal(scenarioMonthlyCents({ price_cents: 1800, monthly_visitors: 1000, conversion_pct: 2 }), 36000);
    assert.equal(scenarioMonthlyCents({ price_cents: 999, monthly_visitors: 333, conversion_pct: 1.5 }), Math.round(333 * 0.015 * 999));
    assert.equal(scenarioMonthlyCents({ price_cents: 1800, monthly_visitors: 0, conversion_pct: 5 }), 0);
  });

  it('starts from the first real price, with editable guesses — and from nothing when there is no price', () => {
    assert.equal(startScenario(emptyPlan('A')), null);
    assert.equal(startScenario(addPriceItem(emptyPlan('A'))), null, 'an unpriced item is not a price');
    assert.deepEqual(startScenario(priced()), { price_cents: 1800, monthly_visitors: 1000, conversion_pct: 2 });
  });

  it('setScenario keeps numbers sane and null removes it', () => {
    let p = setScenario(priced(), { price_cents: 1800, monthly_visitors: 10.7, conversion_pct: 250 });
    assert.deepEqual(p.scenario, { price_cents: 1800, monthly_visitors: 11, conversion_pct: 100 });
    p = setScenario(p, { conversion_pct: -3, monthly_visitors: -5 });
    assert.deepEqual(p.scenario, { price_cents: 1800, monthly_visitors: 0, conversion_pct: 0 });
    assert.equal(setScenario(p, null).scenario, null);
  });
});

describe('money text', () => {
  it('cents ⇄ input', () => {
    assert.equal(centsToInput(1299), '12.99');
    assert.equal(centsToInput(700), '7.00');
    assert.equal(inputToCents('12.99'), 1299);
    assert.equal(inputToCents('12,99'), 1299);
    assert.equal(inputToCents(' 7 '), 700);
    assert.equal(inputToCents('0.5'), 50);
    for (const bad of ['', 'abc', '-3', '1.234', '1e3', '$5']) assert.equal(inputToCents(bad), null, bad);
  });
  it('formatMoney groups thousands', () => {
    assert.equal(formatMoney(123456789), '1,234,567.89');
    assert.equal(formatMoney(0), '0.00');
  });
});

describe('planHints', () => {
  it('lists what is still thin, nothing for a filled-in plan', () => {
    assert.deepEqual(planHints(emptyPlan('A')), ['add a one-line description', "say who it's for", 'say what you offer', 'decide how you will charge (or pick "Free")']);
    const full = setText(setText(setText(priced(), 'one_liner', 'a'), 'audience', 'b'), 'offer', 'c');
    assert.deepEqual(planHints(full), []);
    assert.deepEqual(planHints(setPricingModel(full, 'free')), []);
    assert.deepEqual(planHints({ ...full, pages: [] }), ['list at least one page']);
  });
});

describe('syncedName', () => {
  it('renames only a project that is still "Untitled" (or blank), to a real plan name', () => {
    assert.equal(syncedName('Untitled', 'Bean There'), 'Bean There');
    assert.equal(syncedName('', 'Bean There'), 'Bean There');
    assert.equal(syncedName('  Untitled ', ' Bean There '), 'Bean There');
    assert.equal(syncedName('My shop', 'Bean There'), null, 'a name the owner chose is never overwritten');
    assert.equal(syncedName('Untitled', 'Untitled'), null);
    assert.equal(syncedName('Untitled', '   '), null);
    assert.equal(syncedName('Untitled', 'x'.repeat(300))!.length, 120);
  });
});

describe('splitLiveReply', () => {
  it('shows all of a plain reply', () => {
    assert.deepEqual(splitLiveReply('What do you charge?'), { chat: 'What do you charge?', updating: false });
    assert.deepEqual(splitLiveReply(''), { chat: '', updating: false });
  });
  it('hides the plan block as soon as it starts, and says the plan is being updated', () => {
    assert.deepEqual(splitLiveReply(`Here is a draft.\n${ARTIFACT_MARK}\n{"schema":1,"na`), { chat: 'Here is a draft.', updating: true });
    assert.deepEqual(splitLiveReply(`${ARTIFACT_MARK}{"a":1}`), { chat: '', updating: true });
  });
  it('hides a marker that has only half arrived', () => {
    assert.deepEqual(splitLiveReply('Here is a draft.\n[[ARTI'), { chat: 'Here is a draft.', updating: false });
    assert.deepEqual(splitLiveReply('Two [[ is fine to show if it is not the start of a marker: a [[b'), { chat: 'Two [[ is fine to show if it is not the start of a marker: a [[b', updating: false });
    assert.deepEqual(splitLiveReply('ok [['), { chat: 'ok', updating: false });
  });
  it('uses the very marker the server uses', () => {
    assert.equal(ARTIFACT_MARK, ARTIFACT_OPEN);
  });
});

describe('historyToSend', () => {
  const line = (i: number, role: 'user' | 'assistant'): ChatLine => ({ id: String(i), role, content: `m${i}` });
  const alternating = (n: number): ChatLine[] => Array.from({ length: n }, (_, i) => line(i, i % 2 === 0 ? 'user' : 'assistant'));

  it('sends a short conversation whole, without the ids', () => {
    assert.deepEqual(historyToSend(alternating(3)), [{ role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' }, { role: 'user', content: 'm2' }]);
  });
  it('trims long histories to the newest lines and starts on a user line', () => {
    const sent = historyToSend(alternating(61));
    assert.ok(sent.length <= MAX_HISTORY);
    assert.equal(sent[0]!.role, 'user');
    assert.equal(sent[sent.length - 1]!.content, 'm60');
  });
  it('drops a leading assistant line left by the cut', () => {
    // 32 lines alternate user,assistant,… so the last 5 are m27..m31 = assistant,user,assistant,user,assistant → ends on an assistant line
    const sent = historyToSend(alternating(32), 5);
    assert.deepEqual(sent.map((m) => m.content), ['m28', 'm29', 'm30', 'm31']);
    assert.equal(sent[0]!.role, 'user');
  });
  it('empty in, empty out', () => {
    assert.deepEqual(historyToSend([]), []);
  });
  it('canRetry only when the owner spoke last', () => {
    assert.equal(canRetry(alternating(3)), true);
    assert.equal(canRetry(alternating(2)), false);
    assert.equal(canRetry([]), false);
  });
});

describe('toChatLine', () => {
  it('reads stage_messages rows and skips junk', () => {
    assert.deepEqual(toChatLine({ id: 'a', role: 'user', content: 'hi', created_at: 'x' }), { id: 'a', role: 'user', content: 'hi' });
    for (const bad of [null, 'x', {}, { id: 'a', role: 'system', content: 'x' }, { id: 'a', role: 'user', content: '' }, { id: 5, role: 'user', content: 'x' }]) assert.equal(toChatLine(bad), null);
  });
});

describe('planProblems', () => {
  it('a good plan has none', () => {
    assert.deepEqual(planProblems(priced()), []);
  });
  it('blank pages / prices / names / checklist items are explained in plain words', () => {
    let p = addPriceItem(addPage(emptyPlan('A')));
    p = { ...p, name: '', launch_checklist: [{ id: 'a', label: '', type: 'other', done: false }] };
    assert.deepEqual(planProblems(p), ['The plan needs a name (up to 120 characters)', 'Price 1 needs a name', 'Page 2 needs a title', 'Checklist item 1 needs a label']);
  });
  it('describeProblem leaves what it does not know alone', () => {
    assert.equal(describeProblem('backend.forms: must be a list of names'), 'backend.forms: must be a list of names');
    assert.equal(describeProblem('pages[0].file: must be a simple .html file name'), 'Page 1 needs a simple file name like about.html');
    assert.equal(describeProblem('scenario.conversion_pct: must be between 0 and 100'), 'Revenue what-if: must be between 0 and 100');
  });
});

describe('cleanFileName', () => {
  it('makes a safe .html name', () => {
    assert.equal(cleanFileName('About Us'), 'about-us.html');
    assert.equal(cleanFileName('  Contact.HTML '), 'contact.html');
    assert.equal(cleanFileName('pricing.htm'), 'pricing.html');
    assert.equal(cleanFileName('../etc/passwd'), 'etcpasswd.html');
    assert.equal(cleanFileName('-- x'), 'x.html');
    assert.equal(cleanFileName('   '), '');
    assert.equal(cleanFileName('###'), '');
  });
  it('what it makes is accepted by the validator', () => {
    for (const raw of ['About Us', 'faq', 'Über uns']) {
      const p = updatePage(emptyPlan('A'), 0, { file: cleanFileName(raw), title: 'T' });
      assert.deepEqual(planProblems(p), [], raw);
    }
  });
});

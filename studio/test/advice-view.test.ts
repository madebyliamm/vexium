import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KEEP_MS, WAIT_TEXT, adviceBasis, applyText, askProblem, basisNote, loadAdvice, partnerReady, readAdvice, readPartnerReply, saveAdvice, waitText,
  type KV, type PartnerAdvice,
} from '../src/lib/advice-view.ts';
import { TWEAK_MAX_AGE_MS, setPendingTweak, takePendingTweak } from '../src/lib/pending.ts';
import { ApiError } from '../src/api/http.ts';
import type { BusinessState } from '../src/types/artifacts.ts';

const NOW = Date.parse('2026-10-22T12:10:00Z');

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'stand-out',
  title: 'Make the buttons easier to spot',
  why: 'Lots of people visit but few buy.',
  evidence: [{ id: 'visitors', text: '120 visitors in the last 30 days' }, { id: 'orders', text: '5 orders' }],
  apply: 'Make the main buttons stand out more.',
  ...over,
});
const advice = (over: Record<string, unknown> = {}) => ({
  state_version: 7, computed_at: '2026-10-22T12:00:00Z', period_days: 30, headline: 'You get visitors; fewer buy.', recommendations: [rec()], ...over,
});
const state = (over: Partial<BusinessState> = {}): BusinessState => ({
  schema: 1, computed_at: '2026-10-22T12:00:00Z', period_days: 30, visitors: 120, signups: 0, orders: 5, revenue_cents: 0, data_level: 'ok', ...over,
});

describe('reading the advice', () => {
  it('accepts a valid answer', () => {
    const a = readAdvice(advice());
    assert.ok(a);
    assert.equal(a!.headline, 'You get visitors; fewer buy.');
    assert.equal(a!.recommendations.length, 1);
    assert.deepEqual(a!.recommendations[0]!.evidence.map((e) => e.id), ['visitors', 'orders']);
    assert.equal(a!.recommendations[0]!.apply, 'Make the main buttons stand out more.');
  });

  it('refuses anything that is not advice', () => {
    assert.equal(readAdvice(null), null);
    assert.equal(readAdvice('hi'), null);
    assert.equal(readAdvice(advice({ state_version: 'x' })), null);
    assert.equal(readAdvice(advice({ computed_at: 'yesterday' })), null);
    assert.equal(readAdvice(advice({ recommendations: 'lots' })), null);
  });

  it('leaves out a recommendation that points at no number, has no reason, repeats an id, or is not an object', () => {
    const a = readAdvice(advice({
      recommendations: [
        rec({ id: 'no-evidence', evidence: [] }),
        rec({ id: 'bad-evidence', evidence: [{ id: '', text: 'x' }, { id: 'visitors' }, 7] }),
        rec({ id: 'no-why', why: '  ' }),
        rec({ id: 'no-title', title: '' }),
        rec({ id: 'good' }),
        rec({ id: 'good', title: 'Same id twice' }),
        null,
        'a string',
      ],
    }));
    assert.deepEqual(a!.recommendations.map((r) => r.id), ['good']);
  });

  it('keeps at most four, trims, and turns a blank apply into null', () => {
    const many = Array.from({ length: 7 }, (_, i) => rec({ id: `r${i}`, apply: i === 0 ? '   ' : 'Change it.' }));
    const a = readAdvice(advice({ recommendations: many }))!;
    assert.equal(a.recommendations.length, 4);
    assert.equal(a.recommendations[0]!.apply, null);
    assert.equal(applyText(a.recommendations[0]!), null);
    assert.equal(applyText(a.recommendations[1]!), 'Change it.');
  });

  it('clips very long text instead of drawing a wall', () => {
    const a = readAdvice(advice({ headline: 'h'.repeat(2000), recommendations: [rec({ title: 't'.repeat(900), why: 'w'.repeat(5000), apply: 'a'.repeat(9000) })] }))!;
    assert.ok(a.headline.length <= 400);
    assert.ok(a.recommendations[0]!.title.length <= 140);
    assert.ok(a.recommendations[0]!.why.length <= 500);
    assert.ok(a.recommendations[0]!.apply!.length <= 500);
  });

  it('allows an answer with nothing to recommend', () => {
    const a = readAdvice(advice({ recommendations: [], headline: 'Nothing stands out yet.' }));
    assert.deepEqual(a!.recommendations, []);
  });
});

describe('reading the whole reply', () => {
  it('reads ok and not_enough_data, and nothing else', () => {
    assert.equal(readPartnerReply({ status: 'ok', advice: advice(), cents: 3 })!.status, 'ok');
    const w = readPartnerReply({ status: 'not_enough_data', level: 'early', message: 'Wait.' });
    assert.deepEqual(w, { status: 'not_enough_data', level: 'early', message: 'Wait.' });
    assert.equal(readPartnerReply({ status: 'ok' }), null);
    assert.equal(readPartnerReply({ status: 'weird' }), null);
    assert.equal(readPartnerReply([]), null);
  });

  it('falls back to its own wording when the server sends no message', () => {
    assert.equal((readPartnerReply({ status: 'not_enough_data', level: 'none' }) as { message: string }).message, WAIT_TEXT.none);
    assert.equal((readPartnerReply({ status: 'not_enough_data', level: 'early' }) as { message: string }).message, WAIT_TEXT.early);
  });

  it('only asks when there is enough to read', () => {
    assert.equal(partnerReady(state()), true);
    assert.equal(partnerReady(state({ data_level: 'ok' })), true);
    assert.equal(partnerReady(state({ data_level: 'early' })), false);
    assert.equal(partnerReady(state({ data_level: 'none' })), false);
  });
});

describe('when an ask fails', () => {
  const err = (status: number, body: Record<string, unknown>) => new ApiError(status, String(body.message ?? `Request failed (${status})`), JSON.stringify(body));

  it('old numbers → refresh and try again', () => {
    assert.equal(askProblem(err(409, { error: 'state_old', message: 'Those numbers are out of date.' })).refresh, true);
    assert.equal(askProblem(err(409, { error: 'no_state' })).refresh, true);
  });

  it('a site that is not live is not retried', () => {
    const p = askProblem(err(409, { error: 'not_live' }));
    assert.equal(p.refresh, false);
    assert.match(p.text, /isn’t live yet/);
  });

  it('says when to come back after too many asks', () => {
    assert.match(askProblem(err(429, { error: 'rate_limited', retry_after: 1500 })).text, /about 25 minutes/);
    assert.match(askProblem(err(429, { error: 'rate_limited', retry_after: 20 })).text, /a minute/);
    assert.match(askProblem(err(429, { error: 'rate_limited' })).text, /about 30 minutes/);
  });

  it('uses the server’s own owner-facing sentence for credits and an unavailable partner', () => {
    assert.equal(askProblem(err(402, { error: 'usage_limit', message: 'Your trial credits are used up.' })).text, 'Your trial credits are used up.');
    assert.equal(askProblem(err(503, { error: 'ai_unavailable', message: 'Your business partner is busy right now.' })).text, 'Your business partner is busy right now.');
    assert.match(askProblem(err(502, { error: 'ai_failed', message: 'Something went wrong while I was looking at your numbers.' })).text, /looking at your numbers/);
  });

  it('handles sign-out, a missing project, a lost connection and junk', () => {
    assert.match(askProblem(err(401, {})).text, /sign in/);
    assert.match(askProblem(err(404, {})).text, /couldn’t find/);
    assert.match(askProblem(new TypeError('Failed to fetch')).text, /Couldn’t reach the server/);
    assert.equal(askProblem(new Error('')).text, 'Something went wrong. Please try again.');
    assert.equal(askProblem('weird').text, 'weird');
    assert.equal(askProblem(new ApiError(429, 'x', 'not json')).refresh, false);
  });

  it('words a wait', () => {
    assert.equal(waitText(10), 'a minute');
    assert.equal(waitText(61), 'about 2 minutes');
    assert.equal(waitText(7200), 'an hour');
  });
});

describe('what the advice was made from', () => {
  const a = readAdvice(advice()) as PartnerAdvice;

  it('knows when the screen still shows the same numbers', () => {
    assert.equal(adviceBasis(a, state()), 'current');
    assert.equal(adviceBasis(a, null), 'current');
    assert.equal(adviceBasis(a, state({ period_days: 7 })), 'other_period');
    assert.equal(adviceBasis(a, state({ computed_at: '2026-10-22T12:05:00Z' })), 'older');
  });

  it('says so in the note under the advice', () => {
    assert.equal(basisNote(a, state(), NOW), 'Based on your numbers for the last 30 days, from 10 min ago.');
    assert.match(basisNote(a, state({ period_days: 7 }), NOW), /different range/);
    assert.match(basisNote(a, state({ computed_at: '2026-10-22T12:05:00Z' }), NOW), /ask again for fresh advice/);
  });
});

describe('keeping advice across screens', () => {
  const memory = (): KV & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  const a = readAdvice(advice({ recommendations: [rec({ id: 'a' }), rec({ id: 'b' })] })) as PartnerAdvice;

  it('round-trips advice and what was applied, per project', () => {
    const kv = memory();
    saveAdvice(kv, 'p1', { advice: a, applied: ['b'] });
    assert.deepEqual(loadAdvice(kv, 'p1', NOW), { advice: a, applied: ['b'] });
    assert.equal(loadAdvice(kv, 'p2', NOW), null);
  });

  it('drops applied ids that are not in the advice, and anything unreadable', () => {
    const kv = memory();
    saveAdvice(kv, 'p1', { advice: a, applied: ['b', 'ghost'] });
    assert.deepEqual(loadAdvice(kv, 'p1', NOW)!.applied, ['b']);
    kv.setItem('vx.partner.p3', '{not json');
    assert.equal(loadAdvice(kv, 'p3', NOW), null);
    kv.setItem('vx.partner.p4', JSON.stringify({ advice: { nope: 1 }, applied: [] }));
    assert.equal(loadAdvice(kv, 'p4', NOW), null);
  });

  it('forgets advice a day old', () => {
    const kv = memory();
    saveAdvice(kv, 'p1', { advice: a, applied: [] });
    assert.equal(loadAdvice(kv, 'p1', Date.parse(a.computed_at) + KEEP_MS + 1), null);
    assert.equal(kv.data.size, 0);
  });

  it('never throws when storage is blocked or full', () => {
    const broken: KV = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    assert.doesNotThrow(() => saveAdvice(broken, 'p1', { advice: a, applied: [] }));
    assert.equal(loadAdvice(broken, 'p1', NOW), null);
  });
});

describe('handing a suggested change to TWEAKS', () => {
  it('is taken once, by the project it was for', () => {
    setPendingTweak('p1', 'Make it blue.', 1000);
    assert.equal(takePendingTweak('p2', 1000), null);
    assert.equal(takePendingTweak('p1', 2000), 'Make it blue.');
    assert.equal(takePendingTweak('p1', 2000), null);
  });

  it('expires, so a forgotten one never fires later', () => {
    setPendingTweak('p1', 'Make it blue.', 1000);
    assert.equal(takePendingTweak('p1', 1000 + TWEAK_MAX_AGE_MS + 1), null);
    assert.equal(takePendingTweak('p1', 1000 + TWEAK_MAX_AGE_MS + 1), null);
  });

  it('the newest suggestion replaces an older one', () => {
    setPendingTweak('p1', 'First.', 1000);
    setPendingTweak('p1', 'Second.', 1500);
    assert.equal(takePendingTweak('p1', 1600), 'Second.');
  });
});

// One FULL BUILD model call — run:  node --test cf-worker/test/model.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callModel, classifyHttpError } from '../model.ts';

const REQ = { model: 'claude-test', max_tokens: 20000, system: 'SYSTEM TEXT', prompt: 'write shop.html' };
const ENV = { ANTHROPIC_API_KEY: 'sk-test' };
const page = (t: string) => `<!DOCTYPE html><html><body><h1>${t}</h1></body></html>`;

function sse(parts: { text: string[]; inTok?: number; outTok?: number; cacheWrite?: number; cacheRead?: number; stop?: 'end_turn' | 'max_tokens'; finish?: boolean }): Response {
  const lines: string[] = [];
  const ev = (o: unknown) => lines.push(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
  ev({ type: 'message_start', message: { usage: { input_tokens: parts.inTok ?? 120, cache_creation_input_tokens: parts.cacheWrite ?? 0, cache_read_input_tokens: parts.cacheRead ?? 0, output_tokens: 1 } } });
  for (const t of parts.text) ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
  if (parts.finish !== false) {
    ev({ type: 'message_delta', delta: { stop_reason: parts.stop ?? 'end_turn' }, usage: { output_tokens: parts.outTok ?? 900 } });
    ev({ type: 'message_stop' });
  }
  return new Response(lines.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const fetchOf = (res: Response | (() => Response), seen: { url?: string; init?: RequestInit }[] = []): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return typeof res === 'function' ? res() : res; }) as typeof fetch;
const chunks = (s: string, n = 40) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n));

describe('callModel — a good reply', () => {
  it('returns the page the AI wrote, with the usage Anthropic reported', async () => {
    const text = `<file name="shop.html">\n${page('Shop')}</file>`;
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: chunks(text), inTok: 120, outTok: 900, cacheRead: 5000, cacheWrite: 30 })));
    assert.deepEqual(Object.keys(r.files), ['shop.html']);
    assert.ok(r.files['shop.html']!.includes('<h1>Shop</h1>'));
    assert.deepEqual(r.usage, { in: 120, out: 900, cacheWrite: 30, cacheRead: 5000 });
    assert.equal(r.error, undefined);
    assert.ok(!r.busy && !r.fatal && !r.stopped);
  });
  it('sends the shared system block as a cached block and the page instructions as the user message', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: [`<file name="shop.html">${page('S')}</file>`] }), seen));
    assert.equal(seen[0]!.url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(seen[0]!.init!.body));
    assert.deepEqual(body.system, [{ type: 'text', text: 'SYSTEM TEXT', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'write shop.html' }]);
    assert.deepEqual([body.model, body.max_tokens, body.stream], ['claude-test', 20000, true]);
    const h = seen[0]!.init!.headers as Record<string, string>;
    assert.equal(h['x-api-key'], 'sk-test');
    assert.match(h['anthropic-beta']!, /prompt-caching/);
  });
  it('a test stand-in for Anthropic can be set with ANTHROPIC_BASE_URL (and only then)', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    await callModel({ ...ENV, ANTHROPIC_BASE_URL: 'https://mock.example.test/' }, REQ, new AbortController().signal, fetchOf(sse({ text: [`<file name="shop.html">${page('S')}</file>`] }), seen));
    assert.equal(seen[0]!.url, 'https://mock.example.test/v1/messages');
  });
  it('chat text around the file is ignored', async () => {
    const text = `Here you go!\n<file name="shop.html">${page('Shop')}</file>\nDone.`;
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: chunks(text, 7) })));
    assert.deepEqual(Object.keys(r.files), ['shop.html']);
  });
});

describe('callModel — a page that was cut off', () => {
  it('ran out of room: the half page is handed over so the check can see it is cut off and ask for a shorter one', async () => {
    const half = `<!DOCTYPE html><html><body><h1>Shop</h1><p>${'word '.repeat(200)}`;
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: chunks(`<file name="shop.html">\n${half}`, 90), stop: 'max_tokens', outTok: 20000 })));
    assert.deepEqual(Object.keys(r.files), ['shop.html']);
    assert.ok(r.files['shop.html']!.includes('word word'));
    assert.ok(!r.files['shop.html']!.includes('</html>'));
    assert.equal(r.error, undefined);
    assert.equal(r.usage.out, 20000, 'the tokens are still counted');
  });
  it('the connection dropped before the reply finished: what had been written is kept', async () => {
    const half = `<!DOCTYPE html><html><body><h1>Shop</h1>${'<p>some text here</p>'.repeat(30)}`;
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: chunks(`<file name="shop.html">\n${half}`, 50), finish: false })));
    assert.deepEqual(Object.keys(r.files), ['shop.html']);
    assert.ok(r.files['shop.html']!.includes('some text here'));
  });
  it('a finished page wins over a partial of the same name', async () => {
    const text = `<file name="shop.html">${page('Whole')}</file><file name="shop.html">\n<html><body>partial`;
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: chunks(text, 30) })));
    assert.ok(r.files['shop.html']!.includes('<h1>Whole</h1>'));
  });
  it('nothing written: a busy failure when the stream just stopped, a plain one when the AI finished without a page', async () => {
    const cut = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: ['Let me think about '], finish: false })));
    assert.deepEqual(cut.files, {});
    assert.match(cut.error!, /stopped before finishing/);
    assert.equal(cut.busy, true);
    const empty = await callModel(ENV, REQ, new AbortController().signal, fetchOf(sse({ text: ['I cannot do that.'] })));
    assert.match(empty.error!, /without writing the page/);
    assert.ok(!empty.busy);
  });
});

describe('callModel — failures', () => {
  const err = (status: number, text = '') => () => new Response(text, { status });
  it('bad key / forbidden / out of credit are fatal and say nothing about keys or accounts', async () => {
    for (const [status, text] of [[401, 'invalid x-api-key'], [403, 'nope'], [402, 'pay'], [400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}']] as const) {
      const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(err(status, text)));
      assert.equal(r.fatal, true, String(status));
      assert.ok(!/api[-_ ]?key|x-api|credit balance|sk-/i.test(r.error!), r.error);
      assert.deepEqual(r.files, {});
    }
  });
  it('rate limits, overload and server errors are busy (try again later)', async () => {
    for (const status of [429, 529, 500, 503]) {
      const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(err(status, 'overloaded')));
      assert.equal(r.busy, true, String(status));
      assert.ok(!r.fatal);
    }
  });
  it('another refusal (bad request) is a plain failure of this page', async () => {
    const r = await callModel(ENV, REQ, new AbortController().signal, fetchOf(err(400, 'prompt too long')));
    assert.ok(!r.busy && !r.fatal);
    assert.match(r.error!, /problem with this page/);
    assert.ok(!r.error!.includes('prompt too long'), 'the provider\'s own text is not shown');
  });
  it('the network failing is busy', async () => {
    const r = await callModel(ENV, REQ, new AbortController().signal, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    assert.equal(r.busy, true);
    assert.match(r.error!, /could not be reached/);
  });
  it('classifyHttpError is a pure function of status and text', () => {
    assert.equal(classifyHttpError(400, 'x').fatal, undefined);
    assert.equal(classifyHttpError(400, 'Your credit balance is too low').fatal, true);
  });
});

describe('callModel — Stop', () => {
  it('stopped before the request: nothing is sent back to bill', async () => {
    const ctl = new AbortController();
    const r = await callModel(ENV, REQ, ctl.signal, (async () => { ctl.abort(); throw new DOMException('aborted', 'AbortError'); }) as typeof fetch);
    assert.equal(r.stopped, true);
    assert.deepEqual(r.files, {});
  });
  it('stopped mid-stream: ends at once, reports what was used so far and no page', async () => {
    const ctl = new AbortController();
    const enc = new TextEncoder();
    const line = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        n++;
        if (n === 1) c.enqueue(line({ type: 'message_start', message: { usage: { input_tokens: 77, output_tokens: 1 } } }));
        else if (n === 2) c.enqueue(line({ type: 'content_block_delta', delta: { type: 'text_delta', text: '<file name="shop.html"><html>' + 'x'.repeat(400) } }));
        else if (n === 3) ctl.abort();
        else c.enqueue(line({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'more' } }));
      },
    });
    const r = await callModel(ENV, REQ, ctl.signal, fetchOf(new Response(body, { status: 200 })));
    assert.equal(r.stopped, true);
    assert.deepEqual(r.files, {});
    assert.equal(r.usage.in, 77);
    assert.ok(r.usage.out >= 100, 'the characters written before Stop are estimated and billed');
  });
});

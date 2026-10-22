// FULL BUILD ports (ai-chat operations, heartbeat, model call) — run:  node --test cf-worker/test/build_ports.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiChatOp, concurrencyOf, makePorts, type PortsEnv } from '../build-ports.ts';

const ENV: PortsEnv = {
  SUPABASE_URL: 'https://x.supabase.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  STAGE_WORKER_SECRET: 'worker-secret',
  ANTHROPIC_API_KEY: 'sk-test',
};
const fatal = (m: string) => Object.assign(new Error(m), { name: 'NonRetry' });
const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('aiChatOp', () => {
  it('posts the operation to ai-chat with the shared secret and no user login', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(200, { ok: true, n: 1 }); }) as unknown as typeof fetch;
    const out = await aiChatOp(ENV, { op: 'verify', job_id: 'j', round: 1 }, doFetch, fatal);
    assert.deepEqual(out, { ok: true, n: 1 });
    assert.equal(calls[0]!.url, 'https://x.supabase.test/functions/v1/ai-chat');
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h['x-vx-worker-key'], 'worker-secret');
    assert.ok(!('Authorization' in h) && !('authorization' in h));
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { build_op: { op: 'verify', job_id: 'j', round: 1 } });
  });
  it('throws (so the step is retried) for server errors, rate limits and unreadable answers', async () => {
    for (const r of [reply(500, { error: 'x' }), reply(502, 'bad gateway'), reply(429, { error: 'slow' }), reply(200, 'not json')]) {
      await assert.rejects(aiChatOp(ENV, { op: 'begin' }, (async () => r.clone()) as unknown as typeof fetch, fatal), /ai-chat answered/);
    }
  });
  it('carries the server\'s reason in the error, so the Workflow history says why a step kept failing', async () => {
    await assert.rejects(aiChatOp(ENV, { op: 'begin' }, (async () => reply(500, { error: 'The build step failed.', detail: 'build_steps insert 400 bad column' })) as unknown as typeof fetch, fatal), /ai-chat answered 500: build_steps insert 400 bad column/);
  });
  it('a network error propagates (retried by the step)', async () => {
    await assert.rejects(aiChatOp(ENV, { op: 'begin' }, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, fatal), /fetch failed/);
  });
  it('a wrong secret is not retried', async () => {
    for (const status of [401, 403]) {
      await assert.rejects(aiChatOp(ENV, { op: 'begin' }, (async () => reply(status, { error: 'forbidden' })) as unknown as typeof fetch, fatal), (e: Error) => e.name === 'NonRetry');
    }
  });
  it('other refusals come back as an answer the flow understands, never as ok', async () => {
    const out = await aiChatOp(ENV, { op: 'page_done' }, (async () => reply(400, { error: 'attempt must be 1–10.', code: 'bad_attempt' })) as unknown as typeof fetch, fatal);
    assert.deepEqual(out, { error: 'attempt must be 1–10.', code: 'bad_attempt', ok: false });
    const closed = await aiChatOp(ENV, { op: 'step_start' }, (async () => reply(409, { ok: true, closed: true })) as unknown as typeof fetch, fatal);
    assert.equal(closed.ok, false);
    assert.equal(closed.closed, true);
  });
});

describe('concurrencyOf', () => {
  it('defaults to 4 and stays between 1 and 8', () => {
    assert.equal(concurrencyOf(undefined), 4);
    assert.equal(concurrencyOf('nonsense'), 4);
    assert.equal(concurrencyOf('0'), 1);
    assert.equal(concurrencyOf('3'), 3);
    assert.equal(concurrencyOf('99'), 8);
  });
});

describe('makePorts', () => {
  const jobsUrl = (id: string) => `https://x.supabase.test/rest/v1/build_jobs?id=eq.${id}&status=eq.running&select=id`;

  it('the heartbeat stamps the job and reports whether the owner closed it', async () => {
    const urls: string[] = [];
    const running = (async (url: string) => { urls.push(url); return reply(200, [{ id: 'j1' }]); }) as unknown as typeof fetch;
    assert.equal(await makePorts(ENV, 'j1', running, fatal).beat(), false);
    assert.deepEqual(urls, [jobsUrl('j1')]);
    const closed = (async () => reply(200, [])) as unknown as typeof fetch;
    assert.equal(await makePorts(ENV, 'j1', closed, fatal).beat(), true);
    const trouble = (async () => reply(500, 'x')) as unknown as typeof fetch;
    assert.equal(await makePorts(ENV, 'j1', trouble, fatal).beat(), false, 'a hiccup never ends a good build');
  });

  it('callModel runs the model; Stop (the job closed) is noticed through the heartbeat and ends the call', async () => {
    const enc = new TextEncoder();
    const line = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    let signal: AbortSignal | undefined;
    const doFetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://x.supabase.test/rest')) return reply(200, []); // the job is closed
      signal = init!.signal as AbortSignal;
      let n = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          n++;
          if (n === 1) c.enqueue(line({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } }));
          else { await new Promise((r) => setTimeout(r, 15)); c.enqueue(line({ type: 'content_block_delta', delta: { type: 'text_delta', text: '<file name="a.html">' + 'y'.repeat(200) } })); }
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await makePorts(ENV, 'j1', doFetch, fatal).callModel({ model: 'm', max_tokens: 100, system: 's', prompt: 'p' });
    assert.equal(r.stopped, true);
    assert.equal(signal!.aborted, true);
    assert.equal(r.usage.in, 50);
  });

  it('callModel with a running job returns the page', async () => {
    const text = `<file name="a.html">\n<!DOCTYPE html><html><body>hi</body></html></file>`;
    const sse = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ].map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
    const doFetch = (async (url: string) => String(url).includes('/rest/') ? reply(200, [{ id: 'j1' }]) : new Response(sse, { status: 200 })) as unknown as typeof fetch;
    const r = await makePorts(ENV, 'j1', doFetch, fatal).callModel({ model: 'm', max_tokens: 100, system: 's', prompt: 'p' });
    assert.deepEqual(Object.keys(r.files), ['a.html']);
    assert.deepEqual(r.usage, { in: 10, out: 30, cacheWrite: 0, cacheRead: 0 });
  });
});

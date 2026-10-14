import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBuildEvent, collectBuild, decodeBase64Utf8, emptyBuildResult, streamBuild, toBuildEvent,
  type BuildEvent, type BuildRequest,
} from '../src/api/ai.ts';
import { ApiError, authedFetch, errorMessage, postJson, type AuthDeps } from '../src/api/http.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const REQUEST: BuildRequest = { messages: [{ role: 'user', content: 'a bakery site' }], files: {}, stream: true, main_file: 'index.html' };

/** A fetch that answers with `body` cut into `size`-byte network chunks (splitting multi-byte characters on purpose). */
function fakeFetch(body: string, opts: { status?: number; size?: number; seen?: Request[] } = {}): typeof fetch {
  const bytes = new TextEncoder().encode(body);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    opts.seen?.push(new Request(input as string, init));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const size = opts.size ?? 7;
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    });
    return new Response(opts.status && opts.status >= 400 ? body : stream, { status: opts.status ?? 200 });
  }) as typeof fetch;
}

const deps = (f: typeof fetch, token: string | null = 'tok'): AuthDeps => ({ getToken: async () => token, fetch: f });

async function all(it: AsyncIterable<BuildEvent>): Promise<BuildEvent[]> {
  const out: BuildEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const BUILD =
  sse('start', {}) +
  sse('build_meta', { category: 'restaurant' }) +
  sse('delta', { text: 'Building “Café” 🙂 ' }) +
  sse('file_start', { name: 'index.html' }) +
  sse('file_delta', { text: '<h1>' }) +
  sse('file', { name: 'index.html', content: b64('<h1>Café — 🙂</h1>'), encoding: 'base64' }) +
  sse('file', { name: 'styles.css', content: ':root{--accent:#7c3aed}' }) +
  sse('message', { message: 'Done — your site is ready.' }) +
  sse('suggestions', { items: ['Add a menu page'] }) +
  sse('done', { count: 2 });

test('decodeBase64Utf8 round-trips multi-byte text', () => {
  assert.equal(decodeBase64Utf8(b64('héllo — 🙂 日本')), 'héllo — 🙂 日本');
});

test('toBuildEvent: known events, base64 + plain content, legacy aliases, unknowns, bad JSON', () => {
  assert.deepEqual(toBuildEvent({ event: 'file', data: JSON.stringify({ name: 'a.html', content: b64('é'), encoding: 'base64' }) }), { type: 'file', name: 'a.html', content: 'é' });
  assert.deepEqual(toBuildEvent({ event: 'file', data: JSON.stringify({ name: 'a.css', content: 'x' }) }), { type: 'file', name: 'a.css', content: 'x' });
  assert.deepEqual(toBuildEvent({ event: 'patch_start', data: '{"name":"a.html"}' }), { type: 'file_start', name: 'a.html' });
  assert.deepEqual(toBuildEvent({ event: 'file_start', data: '{"name":"a.html","mode":"patch"}' }), { type: 'file_start', name: 'a.html', mode: 'patch' });
  assert.deepEqual(toBuildEvent({ event: 'error', data: '{}' }), { type: 'error', error: 'Build failed' });
  assert.deepEqual(toBuildEvent({ event: 'future_event', data: '{"a":1}' }), { type: 'unknown', event: 'future_event', data: { a: 1 } });
  assert.deepEqual(toBuildEvent({ event: 'file', data: '{not json' }), { type: 'unknown', event: 'file', data: '{not json' });
});

test('streamBuild yields typed events regardless of network chunking (incl. split multi-byte chars)', async () => {
  const reference = await all(streamBuild(REQUEST, deps(fakeFetch(BUILD, { size: 100000 }))));
  for (const size of [1, 2, 3, 5, 13]) {
    assert.deepEqual(await all(streamBuild(REQUEST, deps(fakeFetch(BUILD, { size })))), reference, `chunk size ${size}`);
  }
  assert.deepEqual(reference.map((e) => e.type), ['start', 'build_meta', 'delta', 'file_start', 'file_delta', 'file', 'file', 'message', 'suggestions', 'done']);
  assert.deepEqual(reference[5], { type: 'file', name: 'index.html', content: '<h1>Café — 🙂</h1>' });
});

test('streamBuild sends the JSON body with apikey + bearer token to the build Worker', async () => {
  const seen: Request[] = [];
  await all(streamBuild(REQUEST, deps(fakeFetch(sse('done', { count: 0 }), { seen }), 'user-token')));
  const req = seen[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://vexium-ai-build.startafter.workers.dev/');
  assert.equal(req.headers.get('authorization'), 'Bearer user-token');
  assert.match(req.headers.get('apikey') ?? '', /^eyJ/);
  assert.equal(req.headers.get('content-type'), 'application/json');
  assert.deepEqual(await req.json(), REQUEST);
});

test('collectBuild folds events into a result; rename/delete/partial/patch_failed handled', async () => {
  const r = await collectBuild(streamBuild(REQUEST, deps(fakeFetch(BUILD))));
  assert.deepEqual(Object.keys(r.files).sort(), ['index.html', 'styles.css']);
  assert.equal(r.message, 'Done — your site is ready.');
  assert.equal(r.chat, 'Building “Café” 🙂 ');
  assert.equal(r.category, 'restaurant');
  assert.deepEqual(r.suggestions, ['Add a menu page']);
  assert.equal(r.completed, true);

  const x = emptyBuildResult();
  for (const e of [
    { type: 'file', name: 'a.html', content: 'A' },
    { type: 'rename', from: 'a.html', to: 'b.html' },
    { type: 'partial_file', name: 'c.html', content: 'cut' },
    { type: 'patch_failed', name: 'd.html' },
    { type: 'file', name: 'e.html', content: 'E' },
    { type: 'delete', name: 'e.html' },
    { type: 'max_tokens_hit' },
    { type: 'error', error: 'boom' },
  ] as BuildEvent[]) applyBuildEvent(x, e);
  assert.deepEqual(x.files, { 'b.html': 'A' });
  assert.deepEqual(x.partial, { 'c.html': 'cut' });
  assert.deepEqual(x.patchFailed, ['d.html']);
  assert.deepEqual(x.deleted, ['e.html']);
  assert.equal(x.maxTokensHit, true);
  assert.equal(x.error, 'boom');
  assert.equal(x.completed, false, 'no `done` event → the stream was cut off');
});

test('a finished file clears its earlier partial', () => {
  const x = emptyBuildResult();
  applyBuildEvent(x, { type: 'partial_file', name: 'a.html', content: 'cut' });
  applyBuildEvent(x, { type: 'file', name: 'a.html', content: 'whole' });
  assert.deepEqual(x.partial, {});
  assert.equal(x.files['a.html'], 'whole');
});

test('streamBuild throws ApiError with the server message on HTTP failure', async () => {
  const f = fakeFetch(JSON.stringify({ error: 'Please sign in to use AI.' }), { status: 401 });
  await assert.rejects(all(streamBuild(REQUEST, deps(f, null))), (e: unknown) => e instanceof ApiError && e.status === 401 && e.message === 'Please sign in to use AI.');
});

test('authedFetch: a 401 triggers ONE forced refresh and a retry with the new token', async () => {
  const calls: string[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization')!;
    calls.push(auth);
    return new Response('{}', { status: auth === 'Bearer fresh' ? 200 : 401 });
  }) as typeof fetch;
  const d: AuthDeps = { fetch: f, getToken: async (force) => (force ? 'fresh' : 'stale') };
  const res = await authedFetch('https://x.test/', { method: 'POST' }, d);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['Bearer stale', 'Bearer fresh']);
});

test('authedFetch: refresh that yields the same token returns the original 401 without hammering', async () => {
  let n = 0;
  const f = (async () => { n++; return new Response('{"error":"nope"}', { status: 401 }); }) as typeof fetch;
  const res = await authedFetch('https://x.test/', {}, { fetch: f, getToken: async () => 'same' });
  assert.equal(res.status, 401);
  assert.equal(n, 2);
});

test('authedFetch without a session sends the anon key (clean 401 from the server) and never retries to success', async () => {
  const seen: string[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('authorization')!); return new Response('{}', { status: 401 }); }) as typeof fetch;
  const res = await authedFetch('https://x.test/', {}, { fetch: f, getToken: async () => null });
  assert.equal(res.status, 401);
  assert.ok(seen.every((a) => a.startsWith('Bearer eyJ')));
});

test('postJson returns parsed JSON, throws ApiError otherwise', async () => {
  const ok = (async () => new Response('{"items":[1]}', { status: 200 })) as typeof fetch;
  assert.deepEqual(await postJson('https://x.test/', { a: 1 }, deps(ok)), { items: [1] });
  const bad = (async () => new Response('{"error":"Invalid JSON"}', { status: 400 })) as typeof fetch;
  await assert.rejects(postJson('https://x.test/', {}, deps(bad)), (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === 'Invalid JSON');
});

test('errorMessage understands the shapes the backends use', () => {
  assert.equal(errorMessage('{"error":"Slug taken"}', 'x'), 'Slug taken');
  assert.equal(errorMessage('{"error":{"message":"Rate limited"}}', 'x'), 'Rate limited');
  assert.equal(errorMessage(JSON.stringify({ error: JSON.stringify({ error: { message: 'Overloaded' } }) }), 'x'), 'Overloaded');
  assert.equal(errorMessage('Bad gateway', 'x'), 'Bad gateway');
  assert.equal(errorMessage('<html>' + 'x'.repeat(400) + '</html>', 'fallback'), 'fallback');
  assert.equal(errorMessage('', 'fallback'), 'fallback');
  assert.equal(errorMessage('{}', 'fallback'), 'fallback');
});

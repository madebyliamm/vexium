// Run:  node --test publisher/test/      (Node ≥ 22.18 runs the .ts files directly)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import worker from '../src/worker.ts';
import { SDK_V1_HASH, SDK_V1_SOURCE } from '../src/sdk.generated.ts';
import { candidates, requestPath, safeKey } from '../src/paths.ts';
import { prepareFiles, slugFrom } from '../src/publish.ts';
import { COLLAB, get, makeWorld, OWNER, PNG_B64, post, SAMPLE_FILES, STRANGER, type World } from './harness.ts';

const call = (w: World, req: Request) => worker.fetch(req, w.env, w.ctx);
const publish = (w: World, body: Record<string, unknown> = {}, token = OWNER.token) =>
  call(w, post('/__vx/publish', { projectId: 'proj_1', files: SAMPLE_FILES, ...body }, token));
const site = (w: World, path: string, headers: Record<string, string> = {}, method = 'GET') =>
  call(w, get('https://liam.vexium.ai' + path, headers, method));

describe('paths', () => {
  it('safeKey rejects traversal, absolute and odd paths', () => {
    for (const bad of ['', '/a', '../a', 'a/../b', 'a//b', 'a\\b', 'a/./b', 'a\u0000b', 'x'.repeat(201), 'dir/', 5 as unknown as string]) assert.equal(safeKey(bad), null, String(bad));
    for (const ok of ['index.html', 'img/logo.png', '.well-known/x.txt']) assert.equal(safeKey(ok), ok);
  });
  it('requestPath decodes and refuses traversal', () => {
    assert.equal(requestPath('/'), '');
    assert.equal(requestPath('/about'), 'about');
    assert.equal(requestPath('/docs/'), 'docs/');
    assert.equal(requestPath('/a%20b.html'), 'a b.html');
    assert.equal(requestPath('/%2e%2e/secret'), null);
    assert.equal(requestPath('/a%2F..%2Fb'), null);
    assert.equal(requestPath('/%E0%A4%A'), null);
  });
  it('candidates', () => {
    assert.deepEqual(candidates('', 'home.html'), ['home.html']);
    assert.deepEqual(candidates('docs/', 'index.html'), ['docs/index.html']);
    assert.deepEqual(candidates('about', 'index.html'), ['about', 'about.html', 'about/index.html']);
    assert.deepEqual(candidates('a/b.css', 'index.html'), ['a/b.css']);
  });
  it('slugFrom matches the editor rule and stays within limits', () => {
    assert.equal(slugFrom('My Bakery!'), 'my-bakery');
    assert.equal(slugFrom('   '), 'my-site');
    assert.equal(slugFrom('é'), 'my-site');
    assert.ok(slugFrom('a'.repeat(200)).length <= 63);
  });
});

describe('prepareFiles', () => {
  it('decodes data URLs, skips _ files, extracts _backend', () => {
    const r = prepareFiles(SAMPLE_FILES);
    assert.ok(r.ok);
    const png = r.items.find((i) => i.key === 'img/logo.png')!;
    assert.equal(png.contentType, 'image/png');
    assert.ok(png.value instanceof Uint8Array);
    assert.equal(Buffer.from(png.value as Uint8Array).toString('base64'), PNG_B64);
    assert.ok(!r.items.some((i) => i.key.startsWith('_')));
    assert.deepEqual((r.backend as any).products[0], { id: 'cake', price_cents: 2500 });
  });
  it('handles percent-encoded data URLs and ignores broken _backend', () => {
    const r = prepareFiles({ 'a.svg': 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E', '_backend': '{nope' });
    assert.ok(r.ok);
    assert.equal(new TextDecoder().decode(r.items[0].value as Uint8Array), '<svg></svg>');
    assert.equal(r.backend, null);
  });
  it('enforces limits', () => {
    assert.equal((prepareFiles({ '../x.html': 'x' }) as any).error, 'bad_path');
    assert.equal((prepareFiles({ 'big.bin': 'x'.repeat(8 * 1024 * 1024 + 1) }) as any).error, 'file_too_large');
    assert.equal((prepareFiles({ 'a.png': 'data:image/png;base64,@@@' }) as any).error, 'bad_data_url');
    assert.equal((prepareFiles(null) as any).error, 'files_required');
  });
});

describe('publish API', () => {
  it('first publish: stores real files, flips the pointer, keeps _backend out of R2', async () => {
    const w = makeWorld();
    const res = await publish(w);
    assert.equal(res.status, 200);
    const out = await res.json() as any;
    assert.deepEqual({ ok: out.ok, version: out.version, slug: out.slug, files: out.files }, { ok: true, version: 1, slug: 'my-bakery', files: 6 });

    assert.deepEqual(w.r2.keys(), ['p/proj_1/v1/404.html', 'p/proj_1/v1/about.html', 'p/proj_1/v1/docs/index.html', 'p/proj_1/v1/img/logo.png', 'p/proj_1/v1/index.html', 'p/proj_1/v1/styles.css']);
    assert.equal(Buffer.from(w.r2.store.get('p/proj_1/v1/img/logo.png')!.bytes).toString('base64'), PNG_B64);
    assert.equal(w.r2.store.get('p/proj_1/v1/img/logo.png')!.contentType, 'image/png');

    const p = w.db.projects[0];
    assert.deepEqual({ slug: p.published_slug, ver: p.published_version, pub: p.is_public }, { slug: 'my-bakery', ver: 1, pub: true });
    assert.ok(p.published_at);
    assert.equal(w.db.deploys.length, 1);
    assert.equal(w.db.deploys[0].status, 'ready');
    assert.equal(w.db.deploys[0].file_count, 6);
    assert.deepEqual(w.db.deploys[0].backend.products, [{ id: 'cake', price_cents: 2500 }]);
  });

  it('republish makes v2 and keeps v1 intact; rollback moves the pointer; unpublish takes it offline', async () => {
    const w = makeWorld();
    await publish(w);
    const r2 = await publish(w, { files: { ...SAMPLE_FILES, 'about.html': '<html><body>About v2</body></html>' } });
    assert.equal(((await r2.json()) as any).version, 2);
    assert.equal(w.r2.text('p/proj_1/v1/about.html')!.includes('About us'), true);

    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About v2'));

    const rb = await call(w, post('/__vx/rollback', { projectId: 'proj_1', version: 1 }, OWNER.token));
    assert.equal(rb.status, 200);
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About us'));
    assert.equal((await site(w, '/my-bakery/about')).headers.get('x-vertly-version'), '1');

    assert.equal((await call(w, post('/__vx/rollback', { projectId: 'proj_1', version: 9 }, OWNER.token))).status, 404);

    const un = await call(w, post('/__vx/unpublish', { projectId: 'proj_1' }, OWNER.token));
    assert.equal(un.status, 200);
    assert.equal((await site(w, '/my-bakery/')).status, 404);
    assert.equal(w.db.projects[0].published_slug, null);
    assert.equal(w.db.projects[0].is_public, false);

    // republish after unpublish continues the numbering (v3), history is kept
    assert.equal(((await (await publish(w)).json()) as any).version, 3);
  });

  it('rejects: no token, bad token, stranger; allows an accepted collaborator', async () => {
    const w = makeWorld();
    assert.equal((await call(w, post('/__vx/publish', { projectId: 'proj_1', files: SAMPLE_FILES }))).status, 401);
    assert.equal((await publish(w, {}, 'garbage')).status, 401);
    assert.equal((await publish(w, {}, STRANGER.token)).status, 403);
    assert.equal(w.r2.store.size, 0);
    assert.equal((await publish(w, {}, COLLAB.token)).status, 200);
    assert.equal((await call(w, post('/__vx/publish', { projectId: 'nope', files: SAMPLE_FILES }, OWNER.token))).status, 403);
  });

  it('validates input before storing anything', async () => {
    const w = makeWorld();
    assert.equal((await publish(w, { files: { 'index.html': 'x', '../evil.html': 'y' } })).status, 400);
    assert.equal((await publish(w, { files: { 'about.html': 'x' } })).status, 400); // main file missing
    const badSlug = await publish(w, { slug: 'Bad Slug!' });
    assert.equal(badSlug.status, 400);
    assert.equal(((await badSlug.json()) as any).error, 'bad_slug');
    assert.equal(w.db.deploys.length, 0); // nothing allocated or stored for any rejected request
    assert.equal(w.r2.store.size, 0);

    const custom = await publish(w, { slug: 'Fresh-Bread' }); // a valid requested slug is lower-cased and used on first publish
    assert.equal(((await custom.json()) as any).slug, 'fresh-bread');
    const again = await publish(w, { slug: 'something-else' }); // once live, the slug is sticky
    assert.equal(((await again.json()) as any).slug, 'fresh-bread');
  });

  it('refuses a slug the same user already uses on another project, before uploading', async () => {
    const w = makeWorld();
    w.db.projects.push({ id: 'proj_2', user_id: OWNER.id, name: 'Other', main_file: 'index.html', published_slug: 'my-bakery', published_version: null, custom_domain: '' });
    const res = await publish(w);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).error, 'slug_taken');
    assert.equal(w.r2.store.size, 0);
    assert.equal(w.db.deploys.length, 0);
  });

  it('a failed upload leaves the previous version live and cleans up', async () => {
    const w = makeWorld();
    await publish(w);
    w.r2.failPutAfter = w.r2.puts + 2; // second file of the next publish fails
    const res = await publish(w, { files: { ...SAMPLE_FILES, 'about.html': 'NEW' } });
    assert.equal(res.status, 500);
    await w.ctx.settle();
    assert.equal(w.db.projects[0].published_version, 1);
    assert.equal(w.r2.keys('p/proj_1/v2/').length, 0);
    assert.equal(w.db.deploys.find((d) => d.version === 2)!.status, 'failed');
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About us'));
  });

  it('prunes versions older than the newest 20 (never the live one)', async () => {
    const w = makeWorld();
    for (let i = 0; i < 23; i++) {
      await publish(w, { files: { 'index.html': `<html><body>v${i + 1}</body></html>` } });
      await w.ctx.settle();
    }
    assert.equal(w.r2.keys('p/proj_1/v1/').length, 0);
    assert.equal(w.r2.keys('p/proj_1/v3/').length, 0);
    assert.equal(w.r2.keys('p/proj_1/v4/').length, 1);
    assert.equal(w.r2.keys('p/proj_1/v23/').length, 1);
    assert.deepEqual(w.db.deploys.map((d) => d.version).sort((a, b) => a - b).slice(0, 2), [4, 5]);
  });

  it('answers CORS preflight and unknown endpoints', async () => {
    const w = makeWorld();
    const pre = await call(w, new Request('https://x.workers.dev/__vx/publish', { method: 'OPTIONS' }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal((await call(w, post('/__vx/nothing', {}, OWNER.token))).status, 404);
    assert.equal((await call(w, get('https://x.workers.dev/__vx/publish'))).status, 405);
  });
});

describe('serving v2 sites', () => {
  async function published() {
    const w = makeWorld();
    await publish(w);
    return w;
  }

  it('serves the main page under /slug with <base>, project id and tracker', async () => {
    const w = await published();
    const res = await site(w, '/my-bakery');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(res.headers.get('content-type')!, /^text\/html/);
    assert.ok(html.includes('<head><base href="/my-bakery/">'));
    assert.ok(html.includes('window.PID="proj_1"'));
    assert.ok(!html.includes('{{VEXIUM_PROJECT_ID}}'));
    assert.ok(html.includes('/functions/v1/track') && html.indexOf('/functions/v1/track') < html.lastIndexOf('</body>'));
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    // SDK: site id first, then the script, both before </body>
    const cfg = html.indexOf('window.__VX={site:"proj_1"}');
    const tag = html.indexOf(`<script src="/__vx/sdk/v1.js?v=${SDK_V1_HASH}"></script>`);
    assert.ok(cfg > 0 && tag > cfg && tag < html.lastIndexOf('</body>'));
  });

  it('custom domains are served from the root without <base>', async () => {
    const w = await published();
    w.db.projects[0].custom_domain = 'www.bakery.com';
    const res = await call(w, get('https://vexium-publisher.workers.dev/', { 'x-forwarded-host': 'WWW.Bakery.com' }));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('<base'));
    assert.ok(html.includes('window.PID="proj_1"'));
    assert.equal((await call(w, get('https://vexium-publisher.workers.dev/about', { 'x-forwarded-host': 'www.bakery.com' }))).status, 200);
    assert.equal((await call(w, get('https://vexium-publisher.workers.dev/', { 'x-forwarded-host': 'unknown.com' }))).status, 404);
  });

  it('resolves extensionless pages, directory indexes, assets with correct types', async () => {
    const w = await published();
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About us'));
    assert.ok((await (await site(w, '/my-bakery/about.html')).text()).includes('About us'));
    assert.ok((await (await site(w, '/my-bakery/docs/')).text()).includes('Docs home'));
    assert.ok((await (await site(w, '/my-bakery/docs')).text()).includes('Docs home'));
    const css = await site(w, '/my-bakery/styles.css');
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), 'body{color:#222}');
    assert.equal(css.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    const img = await site(w, '/my-bakery/img/logo.png');
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG_B64);
  });

  it('returns real 404s (custom 404.html when present) and never serves private files', async () => {
    const w = await published();
    const miss = await site(w, '/my-bakery/nope');
    assert.equal(miss.status, 404);
    assert.ok((await miss.text()).includes('Custom missing page'));
    assert.equal((await site(w, '/my-bakery/_backend')).status, 404);
    assert.equal((await site(w, '/my-bakery/%2e%2e%2f%2e%2e%2fother')).status, 404);
    assert.equal((await site(w, '/no-such-slug/')).status, 404);
    assert.equal((await site(w, '/')).status, 404);
  });

  it('supports ETag/304 for pages and assets, and HEAD', async () => {
    const w = await published();
    const first = await site(w, '/my-bakery/');
    const etag = first.headers.get('etag')!;
    assert.ok(etag);
    assert.equal((await site(w, '/my-bakery/', { 'if-none-match': etag })).status, 304);
    // same file under another base path must NOT validate (its HTML differs)
    w.db.projects[0].custom_domain = 'www.bakery.com';
    const other = await call(w, get('https://p.workers.dev/', { 'x-forwarded-host': 'www.bakery.com', 'if-none-match': etag }));
    assert.equal(other.status, 200);

    const a = await site(w, '/my-bakery/styles.css');
    assert.equal((await site(w, '/my-bakery/styles.css', { 'if-none-match': a.headers.get('etag')! })).status, 304);

    const head = await site(w, '/my-bakery/', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await call(w, new Request('https://liam.vexium.ai/my-bakery/', { method: 'POST' }))).status, 405);
  });

  it('a pointer change is visible immediately in the publishing isolate', async () => {
    const w = await published();
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About us'));
    await publish(w, { files: { ...SAMPLE_FILES, 'about.html': '<html><body>About v2</body></html>' } });
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About v2'));
  });

  it('only calls Supabase once per route within the cache window', async () => {
    const w = await published();
    w.db.calls.length = 0;
    await site(w, '/my-bakery/');
    await site(w, '/my-bakery/about');
    await site(w, '/my-bakery/styles.css');
    assert.equal(w.db.calls.filter((c) => c.includes('resolve_published_site')).length, 1);
  });
});

describe('legacy sites (published_files jsonb)', () => {
  function legacyWorld() {
    const w = makeWorld();
    Object.assign(w.db.projects[0], {
      published_slug: 'my-bakery',
      published_version: null,
      published_files: {
        'index.html': '<html><head><link rel="stylesheet" href="s.css"></head><body><img src="p.png"><div style="background:url(p.png)"></div></body></html>',
        'about.html': '<html><body>About</body></html>',
        's.css': 'body{color:red}',
        'p.png': 'data:image/png;base64,' + PNG_B64,
      },
    });
    return w;
  }

  it('inlines CSS and images exactly like the old Worker, with tracker + base', async () => {
    const w = legacyWorld();
    const res = await site(w, '/my-bakery');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(html.includes('<style>body{color:red}</style>'));
    assert.ok(html.includes('src="data:image/png;base64,'));
    assert.ok(html.includes('url(data:image/png;base64,'));
    assert.ok(html.includes('<base href="/my-bakery/">'));
    assert.ok(html.includes('/functions/v1/track'));
  });

  it('keeps the old page fallbacks (.html suffix, unknown path -> main page)', async () => {
    const w = legacyWorld();
    assert.ok((await (await site(w, '/my-bakery/about')).text()).includes('About'));
    assert.ok((await (await site(w, '/my-bakery/whatever')).text()).includes('<img'));
  });

  it('a republish moves a legacy site to v2', async () => {
    const w = legacyWorld();
    assert.equal((await publish(w)).status, 200);
    const res = await site(w, '/my-bakery/');
    assert.equal(res.headers.get('x-vertly-version'), '1');
  });
});

describe('misc', () => {
  it('health check', async () => {
    const w = makeWorld();
    const res = await call(w, get('https://liam.vexium.ai/__vexium_ping'));
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('Vertly SDK', () => {
  const sdk = (headers: Record<string, string> = {}, path = '/__vx/sdk/v1.js', method = 'GET') =>
    worker.fetch(get('https://liam.vexium.ai' + path, headers, method), makeWorld().env, makeWorld().ctx);

  it('the committed generated module matches sdk/v1.js (run `node scripts/build-sdk.mjs` after editing the SDK)', () => {
    const src = readFileSync(new URL('../../sdk/v1.js', import.meta.url), 'utf8');
    assert.equal(SDK_V1_SOURCE, src);
  });
  it('is served as JavaScript with a year-long immutable cache for the hashed URL', async () => {
    const res = await sdk({}, `/__vx/sdk/v1.js?v=${SDK_V1_HASH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^application\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(await res.text(), SDK_V1_SOURCE);
  });
  it('a bare or stale URL gets the short cache; ETag gives 304; HEAD has no body', async () => {
    for (const p of ['/__vx/sdk/v1.js', '/__vx/sdk/v1.js?v=old']) {
      assert.equal((await sdk({}, p)).headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
    }
    const etag = (await sdk()).headers.get('etag')!;
    assert.equal((await sdk({ 'if-none-match': etag })).status, 304);
    const head = await sdk({}, '/__vx/sdk/v1.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
  it('is the same on a custom domain (x-forwarded-host) and does not need a published site', async () => {
    const res = await sdk({ 'x-forwarded-host': 'www.example.com' });
    assert.equal(res.status, 200);
  });
  it('defines the public API surface and the old aliases', () => {
    for (const name of ['signup', 'login', 'logout', 'user', 'token', 'onChange', 'submit', 'list', 'update', 'remove', 'bind', 'buy', 'buyAmount', 'page']) {
      assert.ok(SDK_V1_SOURCE.includes(name + ':'), name);
    }
    for (const alias of ['vxCall', 'vxSignup', 'vxLogin', 'vxLogout', 'vxCurrentUser', 'vxGetToken', 'vxCheckout', 'vxBuy', 'vxBuyAmount']) {
      assert.ok(SDK_V1_SOURCE.includes('w.' + alias + ' ='), alias);
    }
  });
});

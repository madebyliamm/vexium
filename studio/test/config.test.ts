// Drift guards: the studio's hard-coded endpoints/keys must equal what the rest of the repo uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AI_BUILD_URL, PUBLISH_API, STUDIO_PATH, SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';

const read = (rel: string) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('anon key equals config.js and both wrangler.toml files', () => {
  assert.equal(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/.exec(read('config.js'))?.[1], SUPABASE_ANON_KEY);
  for (const f of ['publisher/wrangler.toml', 'cf-worker/wrangler.toml']) {
    assert.equal(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(read(f))?.[1], SUPABASE_ANON_KEY, f);
  }
});

test('Supabase URL equals config.js', () => {
  assert.equal(/SUPABASE_URL\s*=\s*'([^']+)'/.exec(read('config.js'))?.[1], SUPABASE_URL);
});

test('build Worker and publisher URLs equal the ones editor.html uses', () => {
  const editor = read('editor.html');
  assert.equal(/const AI_BUILD_URL = '([^']+)'/.exec(editor)?.[1], AI_BUILD_URL);
  assert.equal(/const PUBLISH_API = '([^']+)'/.exec(editor)?.[1], PUBLISH_API);
});

test('vite base equals STUDIO_PATH', () => {
  assert.equal(/const BASE = '([^']+)'/.exec(read('studio/vite.config.ts'))?.[1], STUDIO_PATH);
});

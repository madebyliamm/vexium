// scripts/assemble-site.mjs decides what is public on vexium.ai. This pins the allowlist behaviour with a fixture repo.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error — plain .mjs script without type declarations
import { assemble } from '../../scripts/assemble-site.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vx-assemble-'));
  const put = (rel: string, body = 'x') => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  for (const f of ['index.html', 'auth.html', 'config.js', 'logo.png', 'mark.svg', 'sdk/v1.js']) put(f, 'public:' + f);
  for (const f of ['REVAMP.md', 'notes.md', 'package.json', '.gitignore', 'docs/SECURITY_FINDINGS.md', 'supabase/schema.sql', 'publisher/src/index.ts', 'sdk/test/a.mjs', 'studio/src/main.tsx', 'node_modules/x/index.js']) put(f, 'private:' + f);
  put('studio/dist/index.html', 'studio');
  put('studio/dist/assets/app.js', 'bundle');
  return root;
}

test('ships legacy pages, the SDK and the studio build — and nothing else', () => {
  const root = fixture();
  const out = join(root, '_site');
  try {
    const { copied, skippedRoot } = assemble({ root, out, studioDist: join(root, 'studio/dist') });
    const listed = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listed(join(dir, e.name)).map((f) => e.name + '/' + f) : [e.name]));
    assert.deepEqual(listed(out).sort(), ['auth.html', 'config.js', 'index.html', 'logo.png', 'mark.svg', 'sdk/v1.js', 'studio/assets/app.js', 'studio/index.html']);
    assert.ok(copied.includes('studio/'));
    assert.deepEqual(skippedRoot.sort(), ['REVAMP.md', 'notes.md', 'package.json']);
    for (const priv of ['docs', 'supabase', 'publisher', 'REVAMP.md', 'sdk/test', '.gitignore', 'node_modules']) assert.equal(existsSync(join(out, priv)), false, priv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copies legacy files byte-for-byte and replaces a stale output folder', () => {
  const root = fixture();
  const out = join(root, '_site');
  try {
    mkdirSync(out);
    writeFileSync(join(out, 'stale.html'), 'old');
    assemble({ root, out, studioDist: join(root, 'studio/dist') });
    assert.equal(existsSync(join(out, 'stale.html')), false);
    assert.equal(readdirSync(out).includes('index.html'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to run without a studio build (never publishes a site with a dead /studio/)', () => {
  const root = fixture();
  try {
    assert.throws(() => assemble({ root, out: join(root, '_site'), studioDist: join(root, 'nope') }), /studio build not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

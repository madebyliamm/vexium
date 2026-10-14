#!/usr/bin/env node
// Builds the folder GitHub Pages serves (default `_site/`): the legacy static pages exactly as they are in the repo
// root, the SDK file, and the compiled studio under /studio/.
//
// Before Step 6 the workflow published the ENTIRE repo, which put REVAMP.md, docs/SECURITY_FINDINGS.md, supabase/
// (schema + function source), publisher/ … on https://vexium.ai/. This is an allowlist instead: only what a browser
// needs is copied. A root file with an extension outside PUBLIC_ROOT_EXT is reported as "not shipped" (never silently
// dropped without a trace, never silently shipped).
//
//   node scripts/assemble-site.mjs [--out _site] [--studio studio/dist]
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extensions of files at the repo root that are served as-is. */
export const PUBLIC_ROOT_EXT = new Set(['.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.webmanifest', '.txt']);
/** Individual files outside the root that must stay reachable at their old URL (editor/viewer load the SDK from here). */
export const EXTRA_FILES = ['sdk/v1.js'];

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

/**
 * @param {{ root: string, out: string, studioDist: string }} paths
 * @returns {{ copied: string[], skippedRoot: string[] }} names relative to `out` / the repo root
 */
export function assemble({ root, out, studioDist }) {
  if (!existsSync(join(studioDist, 'index.html'))) {
    throw new Error(`studio build not found at ${studioDist} (run \`npm run build\` in studio/ first)`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const copied = [];
  const skippedRoot = [];
  for (const name of readdirSync(root).sort()) {
    const src = join(root, name);
    if (name.startsWith('.') || !statSync(src).isFile()) continue; // directories and dotfiles are never copied wholesale
    if (PUBLIC_ROOT_EXT.has(extname(name).toLowerCase())) {
      copyFileSync(src, join(out, name));
      copied.push(name);
    } else {
      skippedRoot.push(name);
    }
  }
  for (const rel of EXTRA_FILES) {
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(root, rel), dst);
    copied.push(rel);
  }
  copyTree(studioDist, join(out, 'studio'));
  copied.push('studio/');
  return { copied, skippedRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const out = resolve(root, arg('--out', '_site'));
  const studioDist = resolve(root, arg('--studio', 'studio/dist'));
  const { copied, skippedRoot } = assemble({ root, out, studioDist });
  console.log(`site assembled in ${out}`);
  console.log('  shipped:', copied.join(' '));
  console.log('  not shipped (root files outside the allowlist):', skippedRoot.join(' ') || '(none)');
}

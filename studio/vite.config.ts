import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// Must equal STUDIO_PATH in src/lib/config.ts (test/config.test.ts enforces it).
const BASE = '/studio/';
const REPO_ROOT = resolve(import.meta.dirname, '..');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Dev only: serve the legacy static pages (auth.html, home.html, config.js, logos…) from the repo root on the same
 * origin as the studio, so `npm run dev` can sign in through the real auth.html and share its session. In production
 * GitHub Pages serves those files (see scripts/assemble-site.mjs for the list that ships).
 */
function legacyStatic(): Plugin {
  return {
    name: 'vertly-legacy-static',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path.startsWith(BASE) || path.startsWith('/@') || path.startsWith('/node_modules')) return next();
        const ext = extname(path);
        const type = MIME[ext];
        if (!type || path.includes('..') || path.slice(1).includes('/')) return next(); // root-level files only
        const file = resolve(REPO_ROOT, '.' + path);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', type);
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [preact(), legacyStatic()],
  // The studio shares pure modules with the edge functions (supabase/functions/_shared); let the dev server read outside studio/.
  server: { port: 5173, open: false, fs: { allow: [REPO_ROOT] } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});

// Hash router. GitHub Pages has no SPA fallback, so routes live after the hash: /studio/#/p/abc123.
// Pure functions only (unit-tested); the Preact hook is in use-route.ts.

export interface Route<T> {
  /** '/', '/p/:id', '/system'. `:name` matches exactly one non-empty segment. */
  pattern: string;
  view: T;
}

export interface Resolved<T> {
  route: Route<T>;
  params: Record<string, string>;
}

export interface Location {
  path: string;
  query: URLSearchParams;
}

/** '#/p/abc?x=1' → { path: '/p/abc', query: x=1 }. Anything unparseable falls back to '/'. */
export function parseHash(hash: string): Location {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart = '', queryPart = ''] = raw.split('?', 2);
  let path = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { path, query: new URLSearchParams(queryPart) };
}

export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const h = have[i] as string;
    if (w.startsWith(':')) {
      try {
        params[w.slice(1)] = decodeURIComponent(h);
      } catch {
        return null; // malformed %-escape: treat as no match rather than throwing during render
      }
    } else if (w !== h) {
      return null;
    }
  }
  return params;
}

export function resolveRoute<T>(routes: readonly Route<T>[], path: string): Resolved<T> | null {
  for (const route of routes) {
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

/** Fill a pattern: link('/p/:id', { id: 'a b' }) → '#/p/a%20b'. */
export function link(pattern: string, params: Record<string, string> = {}): string {
  const path = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
  return '#' + path;
}

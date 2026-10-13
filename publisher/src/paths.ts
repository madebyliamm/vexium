import { extOf } from './mime.ts';

/** A file path accepted by publish: relative, no traversal, sane length. Returns null if unusable. */
export function safeKey(name: unknown): string | null {
  if (typeof name !== 'string' || !name || name.length > 200) return null;
  if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name)) return null;
  if (name.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  return name;
}

/** Decode a request path into a relative file path ('' = site root). Returns null for anything suspicious. */
export function requestPath(pathname: string): string | null {
  let p = pathname.replace(/^\/+/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p === '') return '';
  const trailingSlash = p.endsWith('/');
  const core = trailingSlash ? p.slice(0, -1) : p;
  if (safeKey(core) === null) return null;
  return trailingSlash ? core + '/' : core;
}

/** R2 keys (relative to the deploy root) to try, in order, for a request path. */
export function candidates(rel: string, mainFile: string): string[] {
  if (rel === '') return [mainFile];
  if (rel.endsWith('/')) return [rel + 'index.html'];
  if (extOf(rel)) return [rel];
  return [rel, rel + '.html', rel + '/index.html'];
}

export function deployPrefix(projectId: string, version: number): string {
  return `p/${projectId}/v${version}/`;
}

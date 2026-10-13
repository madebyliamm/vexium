import { cacheControlFor, isHtml, mimeFor } from './mime.ts';
import { candidates, deployPrefix, requestPath } from './paths.ts';
import { hash, notFoundPage, prepareHtml, TRACKER_VERSION } from './html.ts';
import { fetchLegacyProject, resolveRoute } from './supabase.ts';
import { serveLegacy } from './legacy.ts';
import type { Env, Route } from './types.ts';

const VEXIUM_SUFFIX = '.vexium.ai';

/** Entry for every non-API request: figure out which site this is and serve the requested file. */
export async function handleSite(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(req.url);
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || url.hostname).toLowerCase().split(':')[0];

  let route: Route | null;
  let rel: string | null;
  let baseHref: string;

  if (host.endsWith(VEXIUM_SUFFIX)) {
    // username.vexium.ai/<slug>/<page>
    const rawSlug = url.pathname.replace(/^\//, '').split('/')[0];
    if (!rawSlug) return notFoundPage('No project specified.');
    const slug = decodeSlug(rawSlug);
    rel = requestPath(url.pathname.slice(1 + rawSlug.length));
    baseHref = '/' + slug + '/';
    route = await resolveRoute(env, { username: host.split('.')[0], slug });
    if (!route) return notFoundPage('Project not found or not published.');
  } else {
    // custom domain, served from the root
    rel = requestPath(url.pathname);
    baseHref = '/';
    route = await resolveRoute(env, { host });
    if (!route) return notFoundPage('No published project found for this domain.');
  }
  if (rel === null) return notFoundPage('Page not found.');

  if (route.legacy || route.version === null) {
    const project = await fetchLegacyProject(env, route.project_id);
    if (!project) return notFoundPage('Project not found or not published.');
    return serveLegacy(project, rel, baseHref);
  }
  return serveDeploy(req, env, route, rel, baseHref);
}

function decodeSlug(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function serveDeploy(req: Request, env: Env, route: Route, rel: string, baseHref: string): Promise<Response> {
  const prefix = deployPrefix(route.project_id, route.version as number);

  for (const key of candidates(rel, route.main_file)) {
    const obj = await env.SITES.get(prefix + key);
    if (!obj) continue;
    return respond(req, obj, key, route, baseHref, 200);
  }

  // Real 404 (so dead links are visible to visitors and to the launch verifier), with the site's own 404.html if any.
  const custom = await env.SITES.get(prefix + '404.html');
  if (custom) return respond(req, custom, '404.html', route, baseHref, 404);
  return notFoundPage('Page not found.');
}

async function respond(
  req: Request,
  obj: NonNullable<Awaited<ReturnType<Env['SITES']['get']>>>,
  key: string,
  route: Route,
  baseHref: string,
  status: number,
): Promise<Response> {
  const contentType = mimeFor(key, obj.httpMetadata?.contentType);
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': status === 200 ? cacheControlFor(contentType) : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Vertly-Version': String(route.version),
  });
  const isHead = req.method === 'HEAD';

  if (isHtml(contentType)) {
    // Output depends on the base path + tracker, so the ETag does too.
    const etag = `"${obj.httpEtag.replace(/"/g, '')}-${hash(baseHref)}-t${TRACKER_VERSION}"`;
    if (status === 200) {
      headers.set('ETag', etag);
      if (matches(req, etag)) return new Response(null, { status: 304, headers });
    }
    const html = prepareHtml(await obj.text(), { projectId: route.project_id, baseHref });
    return new Response(isHead ? null : html, { status, headers });
  }

  const etag = obj.httpEtag.startsWith('"') ? obj.httpEtag : `"${obj.httpEtag}"`;
  headers.set('ETag', etag);
  headers.set('Content-Length', String(obj.size));
  if (matches(req, etag)) {
    try { await obj.body?.cancel(); } catch { /* already closed */ }
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(isHead ? null : obj.body, { status, headers });
}

function matches(req: Request, etag: string): boolean {
  const inm = req.headers.get('if-none-match');
  return !!inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

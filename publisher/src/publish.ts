// Publish API. All endpoints: POST, JSON body, `Authorization: Bearer <Supabase user access token>`.
//
//   /__vx/publish    { projectId, files: { path: text | data: URL }, mainFile?, slug? }  -> new immutable version, live
//   /__vx/rollback   { projectId, version }                                              -> move the live pointer
//   /__vx/unpublish  { projectId }                                                       -> take the site offline
//
// A publish never touches the live site until every object is stored: it allocates a version number (a
// project_deploys row in status 'uploading'), writes p/<project>/v<n>/…, marks the deploy 'ready' and only then
// flips projects.published_version. A failed upload leaves the previous version live.

import { mimeFor } from './mime.ts';
import { deployPrefix, safeKey } from './paths.ts';
import { clearRouteCache, enc, getUser, rest } from './supabase.ts';
import type { Ctx, Env } from './types.ts';

export const LIMITS = {
  bodyBytes: 30 * 1024 * 1024,
  files: 500,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
  keepVersions: 20,
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const fail = (status: number, error: string, message?: string) => json({ ok: false, error, message: message || error }, status);

export async function handleApi(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  const action = new URL(req.url).pathname.replace(/^\/__vx\//, '').replace(/\/$/, '');
  if (action !== 'publish' && action !== 'rollback' && action !== 'unpublish') return fail(404, 'unknown_endpoint');

  const len = Number(req.headers.get('content-length') || 0);
  if (len > LIMITS.bodyBytes) return fail(413, 'too_large', 'Your site is over the 25 MB publish limit.');

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = await getUser(env, token);
  if (!user) return fail(401, 'unauthorized', 'Sign in again to publish.');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'bad_json');
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!projectId) return fail(400, 'projectId_required');

  const project = await authorize(env, projectId, user.id);
  if (!project) return fail(403, 'forbidden', 'You do not have access to this project.');

  try {
    if (action === 'publish') return await publish(env, ctx, project, user.id, body);
    if (action === 'rollback') return await rollback(env, project, body);
    return await unpublish(env, project);
  } catch (e) {
    console.error('[publisher] ' + action + ' failed', e);
    return fail(500, 'internal', 'Something went wrong on our side. Your live site was not changed.');
  }
}

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  main_file: string | null;
  published_slug: string | null;
  published_version: number | null;
}

/** Owner or accepted collaborator (same people who can save the project today). */
async function authorize(env: Env, projectId: string, userId: string): Promise<ProjectRow | null> {
  const { data } = await rest<ProjectRow[]>(env, `projects?id=eq.${enc(projectId)}&select=id,user_id,name,main_file,published_slug,published_version&limit=1`);
  const project = Array.isArray(data) && data.length ? data[0] : null;
  if (!project) return null;
  if (project.user_id === userId) return project;
  const m = await rest<unknown[]>(env, `project_members?project_id=eq.${enc(projectId)}&user_id=eq.${enc(userId)}&status=eq.accepted&select=id&limit=1`);
  return Array.isArray(m.data) && m.data.length ? project : null;
}

export function slugFrom(name: string): string {
  return ((name || 'my-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-site').slice(0, 63).replace(/-+$/g, '') || 'my-site';
}

// ── publish ──────────────────────────────────────────────────────────────────────────────────────────
interface Prepared {
  key: string;
  contentType: string;
  value: string | Uint8Array;
  bytes: number;
}

function decodeDataUrl(v: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(v);
  if (!m) return null;
  const payload = v.slice(m[0].length);
  try {
    if (/;base64/i.test(m[2])) {
      const bin = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime: m[1] };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime: m[1] };
  } catch {
    return null;
  }
}

/** Turn the editor's file map into R2 objects. `_`-prefixed files (e.g. `_backend`) are never published. */
export function prepareFiles(files: unknown): { ok: true; items: Prepared[]; backend: unknown; total: number } | { ok: false; error: string; message: string } {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return { ok: false, error: 'files_required', message: 'No files to publish.' };
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > LIMITS.files) return { ok: false, error: 'too_many_files', message: `Sites can have at most ${LIMITS.files} files.` };

  const items: Prepared[] = [];
  let backend: unknown = null;
  let total = 0;
  for (const [name, raw] of entries) {
    if (typeof raw !== 'string') continue; // folders / non-text placeholders in the editor's file system
    if (name.split('/').some((seg) => seg.startsWith('_'))) {
      if (name === '_backend') {
        try {
          backend = JSON.parse(raw);
        } catch {
          backend = null;
        }
      }
      continue;
    }
    const key = safeKey(name);
    if (!key) return { ok: false, error: 'bad_path', message: `"${name.slice(0, 80)}" is not a valid file name.` };

    let value: string | Uint8Array = raw;
    let bytes: number;
    let mime: string | undefined;
    if (raw.startsWith('data:')) {
      const d = decodeDataUrl(raw);
      if (!d) return { ok: false, error: 'bad_data_url', message: `"${key}" could not be decoded.` };
      value = d.bytes;
      bytes = d.bytes.byteLength;
      mime = d.mime || undefined;
    } else {
      bytes = new TextEncoder().encode(raw).byteLength;
    }
    if (bytes > LIMITS.fileBytes) return { ok: false, error: 'file_too_large', message: `"${key}" is over the 8 MB per-file limit.` };
    total += bytes;
    if (total > LIMITS.totalBytes) return { ok: false, error: 'too_large', message: 'Your site is over the 25 MB publish limit.' };
    items.push({ key, contentType: mimeFor(key, mime), value, bytes });
  }
  return { ok: true, items, backend, total };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function allocateVersion(env: Env, projectId: string, userId: string, mainFile: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await rest<Array<{ version: number }>>(env, `project_deploys?project_id=eq.${enc(projectId)}&select=version&order=version.desc&limit=1`);
    const next = (Array.isArray(latest.data) && latest.data.length ? latest.data[0].version : 0) + 1;
    const ins = await rest(env, 'project_deploys', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { project_id: projectId, version: next, created_by: userId, status: 'uploading', main_file: mainFile },
    });
    if (ins.status === 201) return next;
    if (ins.status !== 409) throw new Error('allocate version failed: ' + ins.status);
  }
  throw new Error('could not allocate a deploy version');
}

async function publish(env: Env, ctx: Ctx, project: ProjectRow, userId: string, body: Record<string, any>): Promise<Response> {
  const prepared = prepareFiles(body.files);
  if (!prepared.ok) return fail(400, prepared.error, prepared.message);

  const mainFile = safeKey(body.mainFile) || safeKey(project.main_file) || 'index.html';
  if (!prepared.items.some((i) => i.key === mainFile)) return fail(400, 'main_file_missing', `Your main page "${mainFile}" is not in the files being published.`);

  // The URL slug: keep the live one; otherwise the requested one; otherwise derive it from the project name.
  const requested = typeof body.slug === 'string' ? body.slug.toLowerCase().slice(0, 63).replace(/-+$/, '') : '';
  const slug = project.published_slug || requested || slugFrom(project.name);
  if (!SLUG_RE.test(slug)) return fail(400, 'bad_slug', 'That site address is not valid.');
  const clash = await rest<unknown[]>(env, `projects?user_id=eq.${enc(project.user_id)}&published_slug=eq.${enc(slug)}&id=neq.${enc(project.id)}&select=id&limit=1`);
  if (Array.isArray(clash.data) && clash.data.length) return fail(409, 'slug_taken', `You already have a published site at "${slug}". Rename this project and publish again.`);

  const version = await allocateVersion(env, project.id, userId, mainFile);
  const prefix = deployPrefix(project.id, version);
  const stored: string[] = [];
  try {
    await pool(prepared.items, 8, async (it) => {
      await env.SITES.put(prefix + it.key, it.value, { httpMetadata: { contentType: it.contentType } });
      stored.push(prefix + it.key);
    });
    const ready = await rest(env, `project_deploys?project_id=eq.${enc(project.id)}&version=eq.${version}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'ready', file_count: prepared.items.length, total_bytes: prepared.total, backend: prepared.backend },
    });
    if (ready.status >= 300) throw new Error('mark ready failed: ' + ready.status);

    const now = new Date().toISOString();
    const live = await rest(env, `projects?id=eq.${enc(project.id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { published_slug: slug, published_at: now, published_version: version, is_public: true },
    });
    if (live.status === 409) throw Object.assign(new Error('slug taken'), { slugTaken: true });
    if (live.status >= 300) throw new Error('flip pointer failed: ' + live.status);
  } catch (e) {
    // Roll the half-written deploy back; the previous version stays live.
    ctx.waitUntil(abandon(env, project.id, version, stored));
    if ((e as { slugTaken?: boolean }).slugTaken) return fail(409, 'slug_taken', `You already have a published site at "${slug}".`);
    throw e;
  }

  clearRouteCache();
  ctx.waitUntil(prune(env, project.id, version));
  return json({ ok: true, version, slug, files: prepared.items.length, bytes: prepared.total });
}

async function abandon(env: Env, projectId: string, version: number, keys: string[]): Promise<void> {
  try {
    if (keys.length) await env.SITES.delete(keys.slice(0, 1000));
    await rest(env, `project_deploys?project_id=eq.${enc(projectId)}&version=eq.${version}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'failed' } });
  } catch (e) {
    console.error('[publisher] abandon failed', e);
  }
}

/** Keep the newest LIMITS.keepVersions deploys; delete older files + rows (never the live one). */
async function prune(env: Env, projectId: string, liveVersion: number): Promise<void> {
  try {
    const cutoff = liveVersion - LIMITS.keepVersions;
    if (cutoff < 1) return;
    const old = await rest<Array<{ version: number }>>(env, `project_deploys?project_id=eq.${enc(projectId)}&version=lte.${cutoff}&select=version`);
    for (const d of old.data || []) {
      if (d.version === liveVersion) continue;
      const prefix = deployPrefix(projectId, d.version);
      let cursor: string | undefined;
      do {
        const page = await env.SITES.list({ prefix, cursor, limit: 1000 });
        if (page.objects.length) await env.SITES.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      await rest(env, `project_deploys?project_id=eq.${enc(projectId)}&version=eq.${d.version}`, { method: 'DELETE', prefer: 'return=minimal' });
    }
  } catch (e) {
    console.error('[publisher] prune failed', e);
  }
}

// ── rollback / unpublish ─────────────────────────────────────────────────────────────────────────────
async function rollback(env: Env, project: ProjectRow, body: Record<string, any>): Promise<Response> {
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) return fail(400, 'bad_version');
  if (!project.published_slug) return fail(409, 'not_published', 'This site is not published. Publish it first.');

  const d = await rest<Array<{ version: number; status: string }>>(env, `project_deploys?project_id=eq.${enc(project.id)}&version=eq.${version}&select=version,status&limit=1`);
  if (!Array.isArray(d.data) || !d.data.length || d.data[0].status !== 'ready') return fail(404, 'version_not_found', `Version ${version} is not available.`);

  const r = await rest(env, `projects?id=eq.${enc(project.id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { published_version: version, published_at: new Date().toISOString() },
  });
  if (r.status >= 300) throw new Error('rollback failed: ' + r.status);
  clearRouteCache();
  return json({ ok: true, version, slug: project.published_slug });
}

async function unpublish(env: Env, project: ProjectRow): Promise<Response> {
  const r = await rest(env, `projects?id=eq.${enc(project.id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { published_slug: null, published_at: null, published_version: null, is_public: false },
  });
  if (r.status >= 300) throw new Error('unpublish failed: ' + r.status);
  clearRouteCache();
  return json({ ok: true });
}

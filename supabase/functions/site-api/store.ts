// PostgREST-backed Store for site-api (service role). Every filter value goes through encodeURIComponent; request
// bodies are JSON. The live-vs-draft `_backend` lookup is cached 15 s per isolate (Step 3 hosting: a published
// project's rules come from its live deploy, not the draft).

import type { DataRow, ProjectInfo, RateResult, SessionRow, SiteUserRow, Store } from './handler.ts';

export interface StoreConfig {
  supabaseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
}

const PROJECT_TTL_MS = 15_000;

export function createStore(cfg: StoreConfig): Store {
  const f = cfg.fetch ?? fetch;
  const REST = `${cfg.supabaseUrl}/rest/v1`;
  const base: Record<string, string> = { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` };
  const e = encodeURIComponent;
  const projectCache = new Map<string, { at: number; value: ProjectInfo }>();

  async function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    return await f(`${REST}/${path}`, { ...init, headers: { ...base, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  }
  async function rows<T>(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T[]> {
    const res = await call(path, init);
    if (!res.ok) throw new Error(`rest ${res.status} on ${path.split('?')[0]}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  return {
    async getProject(id) {
      const hit = projectCache.get(id);
      if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.value;

      // Select only the `_backend` entries — `files` can be megabytes of page source.
      const [p] = await rows<{
        id: string; user_id: string; name: string | null; published_version: number | null;
        draft_backend: string | null; pub_backend: string | null;
      }>(`projects?id=eq.${e(id)}&select=id,user_id,name,published_version,draft_backend:files->>_backend,pub_backend:published_files->>_backend&limit=1`);
      if (!p) return null;

      let backend: unknown;
      if (p.published_version != null) {
        const [d] = await rows<{ backend: unknown }>(`project_deploys?project_id=eq.${e(id)}&version=eq.${p.published_version}&status=eq.ready&select=backend&limit=1`);
        backend = d?.backend ?? null;
      } else {
        backend = p.pub_backend ?? p.draft_backend ?? null;
      }
      const value: ProjectInfo = { id: p.id, user_id: p.user_id, name: p.name ?? '', backend };
      projectCache.set(id, { at: Date.now(), value });
      if (projectCache.size > 500) projectCache.delete(projectCache.keys().next().value as string);
      return value;
    },

    async getSiteUserByEmail(projectId, email) {
      const [u] = await rows<SiteUserRow>(`site_users?project_id=eq.${e(projectId)}&email=eq.${e(email)}&select=id,email,password_hash,metadata&limit=1`);
      return u ?? null;
    },

    async createSiteUser(projectId, email, passwordHash, metadata) {
      const res = await call('site_users?select=id,email', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ project_id: projectId, email, password_hash: passwordHash, metadata }),
      });
      if (res.status === 409) return 'exists';
      if (!res.ok) throw new Error(`createSiteUser ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const [u] = await res.json();
      if (!u) throw new Error('createSiteUser: no row returned');
      return { id: u.id, email: u.email };
    },

    async createSession(tokenHash, projectId, siteUserId, expiresAtIso) {
      const res = await call('site_sessions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ token_hash: tokenHash, project_id: projectId, site_user_id: siteUserId, expires_at: expiresAtIso }),
      });
      if (!res.ok) throw new Error(`createSession ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    },

    async getSession(tokenHash, projectId, nowIso) {
      const [s] = await rows<{ site_user_id: string; site_users: { email: string; metadata: Record<string, unknown> | null } | null }>(
        `site_sessions?token_hash=eq.${e(tokenHash)}&project_id=eq.${e(projectId)}&expires_at=gt.${e(nowIso)}&select=site_user_id,site_users(email,metadata)&limit=1`,
      );
      if (!s || !s.site_users) return null;
      const out: SessionRow = { site_user_id: s.site_user_id, email: s.site_users.email, metadata: s.site_users.metadata };
      return out;
    },

    async deleteSession(tokenHash, projectId) {
      await call(`site_sessions?token_hash=eq.${e(tokenHash)}&project_id=eq.${e(projectId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },

    async countRows(projectId, collection) {
      const res = await call(`site_data?project_id=eq.${e(projectId)}&collection=eq.${e(collection)}&select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
      if (!res.ok) throw new Error(`countRows ${res.status}`);
      await res.arrayBuffer(); // drain
      const total = (res.headers.get('content-range') || '').split('/')[1];
      const n = Number(total);
      return Number.isFinite(n) ? n : 0;
    },

    async insertRow(projectId, collection, data, siteUserId) {
      const [r] = await rows<{ id: string }>('site_data?select=id', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ project_id: projectId, collection, data, site_user_id: siteUserId }),
      });
      if (!r) throw new Error('insertRow: no row returned');
      return r;
    },

    async listRows(projectId, collection, opts) {
      let q = `site_data?project_id=eq.${e(projectId)}&collection=eq.${e(collection)}`;
      if (opts.userId) q += `&site_user_id=eq.${e(opts.userId)}`;
      if (opts.beforeIso) q += `&created_at=lt.${e(opts.beforeIso)}`;
      q += `&order=created_at.desc,id.desc&limit=${opts.limit}&select=id,data,created_at`;
      return await rows<DataRow>(q);
    },

    async getOwnRow(projectId, collection, id, userId) {
      const [r] = await rows<DataRow>(`site_data?id=eq.${e(id)}&project_id=eq.${e(projectId)}&collection=eq.${e(collection)}&site_user_id=eq.${e(userId)}&select=id,data,created_at&limit=1`);
      return r ?? null;
    },

    async updateRow(projectId, collection, id, userId, data) {
      const r = await rows<{ id: string }>(`site_data?id=eq.${e(id)}&project_id=eq.${e(projectId)}&collection=eq.${e(collection)}&site_user_id=eq.${e(userId)}&select=id`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ data }),
      });
      return r.length === 1;
    },

    async deleteRow(projectId, collection, id, userId) {
      const r = await rows<{ id: string }>(`site_data?id=eq.${e(id)}&project_id=eq.${e(projectId)}&collection=eq.${e(collection)}&site_user_id=eq.${e(userId)}&select=id`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      return r.length === 1;
    },

    async rateHit(key, windowSeconds, limit, cost): Promise<RateResult> {
      const [r] = await rows<RateResult>('rpc/vx_rate_hit', {
        method: 'POST',
        body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds, p_limit: limit, p_cost: cost }),
      });
      if (!r) throw new Error('vx_rate_hit returned nothing');
      return r;
    },

    async ownerEmail(userId) {
      const res = await f(`${cfg.supabaseUrl}/auth/v1/admin/users/${e(userId)}`, { headers: base });
      if (!res.ok) return null;
      const u = await res.json().catch(() => null);
      return typeof u?.email === 'string' ? u.email : null;
    },
  } satisfies Store;
}

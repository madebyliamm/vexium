import { createHash } from 'node:crypto';
import { clearRouteCache } from '../src/supabase.ts';
import type { Ctx, Env, R2Like, R2ObjectLike } from '../src/types.ts';

// ── fake R2 ───────────────────────────────────────────────────────────────────────────────────────────
export class FakeR2 implements R2Like {
  store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  failPutAfter = Infinity; // simulate an outage on the Nth put
  puts = 0;

  async get(key: string): Promise<R2ObjectLike | null> {
    const e = this.store.get(key);
    if (!e) return null;
    const bytes = e.bytes;
    return {
      key,
      size: bytes.byteLength,
      httpEtag: '"' + createHash('md5').update(bytes).digest('hex') + '"',
      httpMetadata: { contentType: e.contentType },
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array, o?: { httpMetadata?: { contentType?: string } }) {
    if (++this.puts > this.failPutAfter) throw new Error('R2 unavailable');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, { bytes, contentType: o?.httpMetadata?.contentType });
  }
  async list(o: { prefix: string }) {
    return { objects: [...this.store.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })), truncated: false };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }
  keys(prefix = ''): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  text(key: string): string | undefined {
    const e = this.store.get(key);
    return e ? new TextDecoder().decode(e.bytes) : undefined;
  }
}

// ── fake Supabase (only the endpoints the Worker uses) ───────────────────────────────────────────────────
type Row = Record<string, any>;
export class FakeSupabase {
  users: Record<string, string> = {}; // access token -> user id
  profiles: Row[] = [];
  projects: Row[] = [];
  members: Row[] = [];
  deploys: Row[] = [];
  calls: string[] = [];

  private match(rows: Row[], q: URLSearchParams): Row[] {
    return rows.filter((r) => {
      for (const [k, v] of q) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        const [op, ...rest] = v.split('.');
        const val = rest.join('.');
        const cell = r[k];
        if (op === 'eq' && String(cell) !== val) return false;
        if (op === 'neq' && String(cell) === val) return false;
        if (op === 'lte' && !(Number(cell) <= Number(val))) return false;
      }
      return true;
    });
  }

  private resolve(args: Row): Row[] {
    const out = this.projects.filter((p) => {
      if (!p.published_slug) return false;
      if (p.published_version != null) {
        const d = this.deploys.find((x) => x.project_id === p.id && x.version === p.published_version && x.status === 'ready');
        if (!d) return false;
      }
      if (args.p_host) return !!p.custom_domain && p.custom_domain.toLowerCase() === String(args.p_host).toLowerCase();
      const prof = this.profiles.find((x) => x.username === args.p_username);
      return p.published_slug === args.p_slug && !!prof && p.user_id === prof.id;
    });
    return out.slice(0, 1).map((p) => {
      const d = this.deploys.find((x) => x.project_id === p.id && x.version === p.published_version);
      return { project_id: p.id, version: p.published_version ?? null, main_file: d?.main_file || p.main_file || 'index.html', legacy: p.published_version == null };
    });
  }

  fetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const respond = (data: unknown, status = 200) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    this.calls.push(`${method} ${url.pathname}${url.search}`);

    if (url.pathname === '/auth/v1/user') {
      const token = String(init.headers?.Authorization || '').replace('Bearer ', '');
      return this.users[token] ? respond({ id: this.users[token] }) : respond({ message: 'invalid' }, 401);
    }
    if (url.pathname === '/rest/v1/rpc/resolve_published_site') return respond(this.resolve(body));

    const table = url.pathname.replace('/rest/v1/', '');
    const rows: Row[] = (this as any)[table === 'project_members' ? 'members' : table === 'project_deploys' ? 'deploys' : table];
    if (!Array.isArray(rows)) return respond({ message: 'unknown table ' + table }, 404);

    if (method === 'GET') {
      let found = this.match(rows, url.searchParams);
      if (url.searchParams.get('order') === 'version.desc') found = [...found].sort((a, b) => b.version - a.version);
      const limit = Number(url.searchParams.get('limit') || 0);
      return respond(limit ? found.slice(0, limit) : found);
    }
    if (method === 'POST') {
      if (table === 'project_deploys' && rows.some((r) => r.project_id === body.project_id && r.version === body.version)) return respond({ code: '23505' }, 409);
      rows.push({ created_at: new Date().toISOString(), ...body });
      return respond(undefined, 201);
    }
    if (method === 'PATCH') {
      const targets = this.match(rows, url.searchParams);
      if (table === 'projects' && body.published_slug) {
        const t = targets[0];
        if (t && this.projects.some((p) => p.id !== t.id && p.user_id === t.user_id && p.published_slug === body.published_slug)) return respond({ code: '23505' }, 409);
      }
      for (const r of targets) Object.assign(r, body);
      return respond(undefined, 204);
    }
    if (method === 'DELETE') {
      const targets = new Set(this.match(rows, url.searchParams));
      for (let i = rows.length - 1; i >= 0; i--) if (targets.has(rows[i])) rows.splice(i, 1);
      return respond(undefined, 204);
    }
    return respond({ message: 'unsupported' }, 400);
  };
}

// ── world ─────────────────────────────────────────────────────────────────────────────────────────────
export interface World {
  env: Env;
  r2: FakeR2;
  db: FakeSupabase;
  ctx: Ctx & { settle(): Promise<void> };
}

export const OWNER = { id: 'user-owner', token: 'tok-owner', username: 'liam' };
export const STRANGER = { id: 'user-stranger', token: 'tok-stranger' };
export const COLLAB = { id: 'user-collab', token: 'tok-collab' };

export function makeWorld(): World {
  clearRouteCache();
  const r2 = new FakeR2();
  const db = new FakeSupabase();
  db.users = { [OWNER.token]: OWNER.id, [STRANGER.token]: STRANGER.id, [COLLAB.token]: COLLAB.id };
  db.profiles = [{ id: OWNER.id, username: OWNER.username }];
  db.projects = [{ id: 'proj_1', user_id: OWNER.id, name: 'My Bakery!', main_file: 'index.html', published_slug: null, published_version: null, custom_domain: '', is_public: false }];
  db.members = [{ project_id: 'proj_1', user_id: COLLAB.id, status: 'accepted' }];
  (globalThis as any).fetch = db.fetch;

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    settle: async () => { await Promise.all(pending.splice(0)); },
  };
  const env: Env = { SITES: r2, SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
  return { env, r2, db, ctx };
}

export function post(path: string, body: unknown, token?: string): Request {
  return new Request('https://liam.vexium.ai' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
}

export function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const SAMPLE_FILES: Record<string, string> = {
  'index.html': '<!doctype html><html><head><title>Bakery</title><link rel="stylesheet" href="styles.css"></head><body><h1>Hi</h1><img src="img/logo.png"><script>window.PID="{{VEXIUM_PROJECT_ID}}"</script></body></html>',
  'about.html': '<html><head></head><body>About us</body></html>',
  'docs/index.html': '<html><body>Docs home</body></html>',
  '404.html': '<html><body>Custom missing page</body></html>',
  'styles.css': 'body{color:#222}',
  'img/logo.png': 'data:image/png;base64,' + PNG_B64,
  '_backend': JSON.stringify({ collections: { orders: { read: 'owner' } }, products: [{ id: 'cake', price_cents: 2500 }] }),
};

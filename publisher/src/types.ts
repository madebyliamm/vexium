// Minimal structural types for the bits of the Workers runtime we use, so the publisher can be unit-tested in plain
// Node with a fake bucket (no @cloudflare/workers-types dependency, no Miniflare).

export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  body: ReadableStream | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Env {
  SITES: R2Like;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** secret — `wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config publisher/wrangler.toml` */
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

/** What `resolve_published_site` returns: where a request should be served from. */
export interface Route {
  project_id: string;
  version: number | null;
  main_file: string;
  legacy: boolean;
}

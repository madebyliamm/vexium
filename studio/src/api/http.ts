// Authenticated fetch for the Vertly backends (ai-chat, build Worker, publisher). Pure: the token source is injected,
// so it is unit-tested without Supabase (see test/ai.test.ts); api/deps.ts wires the real one.
import { SUPABASE_ANON_KEY } from '../lib/config.ts';

export interface AuthDeps {
  /** The signed-in user's access token. `force` = refresh it first (used once after a 401). null = not signed in. */
  getToken(force: boolean): Promise<string | null>;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, message: string, body = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function messageFrom(value: unknown, depth: number): string | null {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      return messageFrom(JSON.parse(text), depth + 1) ?? text;
    } catch {
      return text; // plain text, not wrapped JSON
    }
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message) return o.message;
    if (o.error !== undefined) return messageFrom(o.error, depth + 1);
  }
  return null;
}

/** Edge errors arrive as {error:"msg"}, {error:{message}}, or {error:"<json string>"} (a wrapped upstream error). */
export function errorMessage(raw: string, fallback: string): string {
  const text = raw.trim();
  if (!text) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.length > 300 ? fallback : text; // an HTML error page etc. is not a message
  }
  return messageFrom(parsed, 0) ?? fallback;
}

export async function errorFromResponse(res: Response): Promise<ApiError> {
  const body = await res.text().catch(() => '');
  return new ApiError(res.status, errorMessage(body, `Request failed (${res.status})`), body);
}

/** Adds apikey + the user's bearer token; on a 401 refreshes the token once and retries with the new one. */
export async function authedFetch(url: string, init: RequestInit, deps: AuthDeps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const send = async (force: boolean): Promise<{ res: Response; token: string | null }> => {
    const token = await deps.getToken(force);
    const headers = new Headers(init.headers);
    headers.set('apikey', SUPABASE_ANON_KEY);
    // No token → send the anon key so the server answers a clean 401 instead of failing at the gateway.
    headers.set('Authorization', 'Bearer ' + (token ?? SUPABASE_ANON_KEY));
    return { res: await doFetch(url, { ...init, headers }), token };
  };

  const first = await send(false);
  if (first.res.status !== 401) return first.res;
  const second = await send(true);
  // A refresh that produced the same (or no) token can't change the answer; return the original 401.
  return second.token && second.token !== first.token ? second.res : first.res;
}

/** POST JSON, expect a JSON answer. Throws ApiError on any non-2xx. */
export async function postJson<T>(url: string, body: unknown, deps: AuthDeps, signal?: AbortSignal): Promise<T> {
  const res = await authedFetch(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) },
    deps,
  );
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as T;
}

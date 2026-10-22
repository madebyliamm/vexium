// FULL BUILD (REVAMP Step 10) — the real connections behind build-flow.ts: ai-chat operations, the job heartbeat and the model call.
// Free of Cloudflare imports (fetch and the "do not retry" error are injected) so it is unit-tested under Node.

import { callModel, type ModelEnv } from './model.ts';
import { touchJob } from './stage-report.ts';
import type { BuildPorts, OpResult, Usage } from './build-flow.ts';

export interface PortsEnv extends ModelEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Shared with ai-chat: the only credential a build operation needs (a Workflow outlives the owner's login). */
  STAGE_WORKER_SECRET: string;
  /** Optional: pages written at the same time (1–8, default 4). */
  BUILD_CONCURRENCY?: string;
}

export const HEARTBEAT_MS = 8000;

export function concurrencyOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
}

/** POST one build operation to ai-chat. Shared by the Workflow and by the Worker (which closes a job it could not start). */
export async function aiChatOp(
  env: PortsEnv,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  fatal: (message: string) => Error,
): Promise<OpResult> {
  const res = await doFetch(`${env.SUPABASE_URL}/functions/v1/ai-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, 'x-vx-worker-key': env.STAGE_WORKER_SECRET },
    body: JSON.stringify({ build_op: body }),
  });
  const json = (await res.json().catch(() => null)) as (OpResult & { detail?: unknown }) | null;
  // Trouble on the other side (or in between): throw, and the step is tried again a little later.
  if (res.status >= 500 || res.status === 429 || res.status === 408 || !json || typeof json !== 'object') {
    const why = json && typeof json === 'object' && typeof json.detail === 'string' ? `: ${json.detail.slice(0, 200)}` : '';
    throw new Error(`ai-chat answered ${res.status}${why}`);
  }
  // The shared secret is wrong: no retry will change that.
  if (res.status === 401 || res.status === 403) throw fatal('The build service is not set up correctly.');
  // Any other refusal is an answer the flow understands (job closed, page rejected…).
  return res.ok ? json : { ...json, ok: false };
}

export function makePorts(env: PortsEnv, jobId: string, doFetch: typeof fetch, fatal: (message: string) => Error): BuildPorts {
  const beat = async (): Promise<boolean> => (await touchJob(doFetch, env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, jobId)) === 'closed';
  return {
    concurrency: concurrencyOf(env.BUILD_CONCURRENCY),
    fatal,
    beat,
    op: (body) => aiChatOp(env, body, doFetch, fatal),
    async callModel(req) {
      // The owner's Stop closes the job row; noticing it here ends the (billed) generation within a few seconds.
      const ctl = new AbortController();
      const usage: Usage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
      void beat().then((closed) => { if (closed) ctl.abort(); });
      const timer = setInterval(() => { void beat().then((closed) => { if (closed) ctl.abort(); }); }, HEARTBEAT_MS);
      try {
        return await callModel(env, req, ctl.signal, doFetch, usage);
      } finally {
        clearInterval(timer);
      }
    },
  };
}

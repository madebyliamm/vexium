// Vexium AI Build Worker (Cloudflare)
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: Supabase Edge Functions are killed at a ~150s wall-clock limit, which caps a
// single build at ~10k output tokens. Big pages got cut and had to be stitched back together by the
// continuation flow — and mid-file stitching is inherently fragile (duplicated/dropped code).
// Cloudflare Workers bill CPU time, not wall-clock, and a streaming LLM proxy is almost all idle
// I/O — so the whole page can generate in ONE Anthropic stream with no timeout. No cut, no stitch.
//
// DESIGN: all the prompt logic (system prompt, onboarding gate, category freeze, component library,
// continuation context) STAYS in the Supabase `ai-chat` function. This Worker asks it to PREPARE the
// Anthropic request (prepare:true → returns the payload, no Anthropic call), then runs that payload
// against Anthropic here, parses the stream with the SAME core as the edge function (core.ts is
// byte-extracted from it), streams Vexium SSE events back to the client, and tracks usage.
//
// Secrets (set via `wrangler secret put`): ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, STAGE_WORKER_SECRET
// Vars (wrangler.toml): SUPABASE_URL, SUPABASE_ANON_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { streamBuild, tokensToCents } from "./core.ts";
import { judgeRun, reportStageDone, touchJob } from "./stage-report.ts";

interface Env {
  ANTHROPIC_API_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Shared with ai-chat (Supabase function secret of the same name): proves a stage_done report comes from this Worker. */
  STAGE_WORKER_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Atomic usage RPC (same as the edge function). Fire-and-forget.
async function incrementUsage(env: Env, userId: string, inputTokens: number, outputTokens: number, model: string, cacheWrite = 0, cacheRead = 0): Promise<void> {
  if (!userId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const cents = tokensToCents(inputTokens, outputTokens, model, cacheWrite, cacheRead);
  if (cents <= 0) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId, p_cents: cents }),
    });
  } catch { /* never block the build */ }
}

// Bill only the DELTA since the last flush — call repeatedly during the stream so an interrupted
// build (Stop / disconnect) still records what it generated. Same logic as the edge function.
type UsageAcc = { in: number; out: number; cacheWrite: number; cacheRead: number };
function makeUsageFlusher(env: Env, userId: string, model: string, usage: UsageAcc): () => void {
  const flushed: UsageAcc = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
  return () => {
    const dIn = usage.in - flushed.in, dOut = usage.out - flushed.out, dCW = usage.cacheWrite - flushed.cacheWrite, dCR = usage.cacheRead - flushed.cacheRead;
    if (dIn <= 0 && dOut <= 0 && dCW <= 0 && dCR <= 0) return;
    flushed.in = usage.in; flushed.out = usage.out; flushed.cacheWrite = usage.cacheWrite; flushed.cacheRead = usage.cacheRead;
    if (userId) incrementUsage(env, userId, dIn, dOut, model, dCW, dCR).catch(() => {});
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

    const authHeader = req.headers.get("Authorization") || "";
    const apikey = req.headers.get("apikey") || env.SUPABASE_ANON_KEY || "";
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Bad request body" }, 400);

    const AI_CHAT_URL = `${env.SUPABASE_URL}/functions/v1/ai-chat`;
    const sbHeaders = { "Content-Type": "application/json", "Authorization": authHeader, "apikey": apikey };

    // 1. Ask the edge function to PREPARE the request (all prompt logic lives there; no Anthropic call).
    let prep: any;
    try {
      const r = await fetch(AI_CHAT_URL, { method: "POST", headers: sbHeaders, body: JSON.stringify({ ...body, prepare: true }) });
      const text = await r.text();
      if (!r.ok) return new Response(text, { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
      prep = JSON.parse(text);
    } catch (e) {
      return json({ error: "prepare failed: " + String(e) }, 502);
    }

    // The edge function may answer directly (rate limit, validation error, onboarding handled inline).
    if (prep && prep.kind === "response") {
      return new Response(JSON.stringify(prep.body), { status: prep.status || 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (!prep || prep.kind !== "run" || !prep.payload) {
      return json({ error: "Unexpected prepare result" }, 502);
    }

    const payload = prep.payload;          // { model, max_tokens, system, messages, stream }
    const filesForPatching = prep.files_for_patching || {};
    const userId: string = prep.user_id || "";
    const model: string = payload.model || "";
    // Studio stage run (REVAMP Step 7): ai-chat created a build_jobs row; after streaming we report the outcome so it can save the artifact.
    const job: { id: string; stage: string } | undefined = prep.job && typeof prep.job.id === "string" ? prep.job : undefined;

    // 2. Stream Anthropic → client (Vexium SSE events), tracking usage incrementally.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let writerClosed = false;
    const safeWrite = async (chunk: Uint8Array) => { if (writerClosed) return; try { await writer.write(chunk); } catch { writerClosed = true; } };
    const safeClose = async () => { if (writerClosed) return; writerClosed = true; try { await writer.close(); } catch {} };
    const emit = async (event: string, data: unknown) => { await safeWrite(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };

    const usageAcc: UsageAcc = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
    const flushUsage = makeUsageFlusher(env, userId, model, usageAcc);

    // Stage runs outlive the browser: a refresh/disconnect must NOT cancel generation (that is what makes them resumable — the result
    // is saved server-side), so they are aborted only when their job row is closed (explicit Stop, or a newer run). The legacy
    // build path keeps its Stop-on-disconnect behaviour. NB ctx.waitUntil only extends a disconnected request by 30 s (Cloudflare
    // limit), so this carries short runs (PLAN); the long stages need a Queue/Durable Object (see docs/STAGES.md).
    const runAbort = new AbortController();
    const runSignal: AbortSignal = job ? runAbort.signal : req.signal;
    let pulsing = false;
    const pulse = async (): Promise<void> => {
      if (!job || pulsing) return;
      pulsing = true;
      try {
        if ((await touchJob(fetch, env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, job.id)) === "closed") runAbort.abort();
      } finally { pulsing = false; }
    };

    const task = (async () => {
      const heartbeat = setInterval(() => { safeWrite(encoder.encode(": hb\n\n")); flushUsage(); void pulse(); }, 8000);
      let apiError: string | null = null;
      let replyText = "";
      let replyFiles: Record<string, string> = {};
      let sawDone = false; // the parser said `done` = Anthropic finished normally (message_stop)
      const emitTracked = async (event: string, data: unknown) => { if (event === "done") sawDone = true; await emit(event, data); };
      try {
        if (prep.category) await emit("build_meta", { category: prep.category });
        if (job) {
          await emit("stage_job", { job_id: job.id, stage: job.stage });
          await pulse(); // first heartbeat before the (long) Anthropic call, so the studio sees a live run straight away
        }

        const aRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31,output-128k-2025-02-19",
          },
          body: JSON.stringify(payload),
          signal: runSignal,
        });

        if (!aRes.ok) {
          await emit("error", { error: await aRes.text().catch(() => "Anthropic error") });
          apiError = "The AI service had a problem. Please try again.";
        } else {
          const result = await streamBuild(aRes, filesForPatching, emitTracked, usageAcc, runSignal);
          replyText = result.message;
          replyFiles = result.files;

          // Follow-up suggestions — ask the edge function (keeps that prompt + Haiku call on Supabase).
          if (prep.want_suggestions && !req.signal.aborted) {
            try {
              const sr = await fetch(AI_CHAT_URL, {
                method: "POST",
                headers: sbHeaders,
                body: JSON.stringify({ suggest: true, built_message: result.message, built_files: result.files, messages: prep.suggestion_messages || [] }),
              });
              if (sr.ok) {
                const sj: any = await sr.json().catch(() => ({}));
                if (Array.isArray(sj.items) && sj.items.length) await emit("suggestions", { items: sj.items });
              }
            } catch { /* suggestions are best-effort */ }
          }
        }
      } catch (e) {
        try { await emit("error", { error: String(e) }); } catch {}
        apiError = apiError || "The run failed. Please try again.";
      } finally {
        clearInterval(heartbeat);
        flushUsage();
        if (job) {
          // Save the result server-side even if the browser is gone (refresh/close) — that is what makes stage runs resumable.
          const outcome = await reportStageDone(fetch, AI_CHAT_URL, { ...sbHeaders, "x-vx-worker-key": env.STAGE_WORKER_SECRET }, job.id, judgeRun({ aborted: runSignal.aborted, apiError, message: replyText, files: replyFiles, finished: sawDone }));
          await emit("stage_done", outcome);
        }
        await safeClose();
      }
    })();

    // Keep the Worker alive to finish the stream + usage tracking even after the client disconnects.
    ctx.waitUntil(task);

    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  },
};

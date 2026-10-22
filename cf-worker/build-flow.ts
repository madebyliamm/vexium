// FULL BUILD (REVAMP Step 10) — the control flow of a build, as plain TypeScript with no Cloudflare imports so it is unit-tested under
// Node (cf-worker/test/build_flow.test.ts). workflow.ts adapts it to a Cloudflare Workflow: each `steps.run` becomes a durable
// `step.do`, so a build survives the Worker being restarted, a model call failing, or the owner closing the browser.
//
// The Worker holds no prompt logic. ai-chat (supabase/functions/ai-chat/build-handler.ts) says what to write, checks and keeps every
// page, and decides when the site is good enough to commit; this flow only moves messages and runs the model:
//
//   begin ─▶ for every page, in parallel (first page alone for a few seconds so the shared prompt is cached for the rest):
//              step_start ─▶ model call ─▶ page_done          (retry a failed page; a retry is a new numbered attempt)
//        ─▶ verify ─▶ repairs?  yes: the same loop for each repair, then verify again (ai-chat limits the rounds)
//        ─▶ complete                                          (ai-chat commits the site and closes the job)
// Anything unexpected ends with `fail`, which closes the job so the studio stops waiting.

/** What a step needs to look like to the flow: durable, named, retried. Names must be unique per step and stable across replays. */
export interface Steps {
  run<T>(name: string, opts: { retries: number; timeout: string }, cb: () => Promise<T>): Promise<T>;
  sleep(name: string, seconds: number): Promise<void>;
}

export interface Usage {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelRequest {
  model: string;
  max_tokens: number;
  /** The shared, cached system block. */
  system: string;
  /** This call's page (or repair) instructions. */
  prompt: string;
}
export interface ModelResult {
  /** The completed `<file>` blocks (a page cut off mid-way is included, partial, so it can be repaired). */
  files: Record<string, string>;
  usage: Usage;
  /** Why nothing usable came back. */
  error?: string;
  /** The model service was busy or unreachable: trying again later may work. */
  busy?: boolean;
  /** Trying again cannot work (bad key, no credit…): the whole build stops. */
  fatal?: boolean;
  /** The job was closed (Stop / replaced) while the call ran. */
  stopped?: boolean;
}

export interface OpResult {
  ok?: boolean;
  closed?: boolean;
  stop?: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface BuildPorts {
  /** One ai-chat build operation. Throws to be retried (network, 5xx); throws `fatal(...)` for an answer that retrying cannot change. */
  op(body: Record<string, unknown>): Promise<OpResult>;
  /** Runs one model call to the end. Never throws for an expected failure — those come back in the result. */
  callModel(req: ModelRequest): Promise<ModelResult>;
  /** Heartbeat for the studio ("this build is alive"); true when the owner closed the job. */
  beat(): Promise<boolean>;
  /** An error the step runner must not retry. */
  fatal(message: string): Error;
  /** Pages written at the same time. */
  concurrency: number;
}

export interface BuildOutcome {
  outcome: 'complete' | 'closed' | 'failed';
  error?: string;
}

interface PageJob {
  seq: number;
  file: string;
  prompt: string;
}

const OP_STEP = { retries: 4, timeout: '3 minutes' } as const;
/** A page of up to ~20k tokens takes a few minutes to write; the model call is not retried by the runner (its attempts are counted and billed). */
const MODEL_STEP = { retries: 0, timeout: '15 minutes' } as const;
const PAGE_TRIES = 3;
const REPAIR_TRIES = 2;
/** Long enough for the first request's prompt to be cached, so the other pages read it at a tenth of the price. */
const CACHE_WARM_SECONDS = 6;

/** Runs `fn` over `items` with at most `limit` at a time. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function runBuild(jobId: string, steps: Steps, ports: BuildPorts): Promise<BuildOutcome> {
  const state = { closed: false, error: null as string | null };
  const op = (name: string, body: Record<string, unknown>): Promise<OpResult> => steps.run(name, OP_STEP, () => ports.op({ ...body, job_id: jobId }));

  try {
    const begin = await op('begin', { op: 'begin' });
    if (begin.closed) return { outcome: 'closed' };
    // ai-chat has already failed the job (the inputs went stale, access was removed…): nothing for us to close.
    if (begin.ok !== true) return { outcome: 'failed', error: String(begin.error ?? 'The build could not start.') };
    const model = String(begin.model), system = String(begin.system), maxTokens = Number(begin.max_tokens);
    const first = (Array.isArray(begin.pages) ? begin.pages as PageJob[] : []).map((p): PageJob => ({ seq: p.seq, file: p.file, prompt: p.prompt }));

    /** Writes one page (or repair) until it is accepted, the tries run out, or the build is over. */
    const writePage = async (page: PageJob, tries: number, warmFirst: boolean): Promise<void> => {
      if (warmFirst) await steps.sleep(`warm-${page.seq}`, CACHE_WARM_SECONDS);
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (state.closed || state.error) return;
        const start = await op(`start-${page.seq}-${attempt}`, { op: 'step_start', seq: page.seq });
        if (start.closed) { state.closed = true; return; }
        if (start.stop) { state.error = String(start.error ?? 'You have used all your AI credits.'); return; }

        // A model step that blew up or timed out is one failed try of this page, not the end of the build (what it spent is unknown).
        const call: ModelResult = await steps.run(`write-${page.seq}-${attempt}`, MODEL_STEP, () => ports.callModel({ model, max_tokens: maxTokens, system, prompt: page.prompt }))
          .catch((): ModelResult => ({ files: {}, usage: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 }, error: 'The AI did not answer in time.', busy: true }));
        const report = await op(`report-${page.seq}-${attempt}`, {
          op: 'page_done', seq: page.seq, attempt, usage: call.usage,
          ...(call.error ? { error: call.error } : { files: call.files }),
        });
        if (report.closed || call.stopped) { state.closed = true; return; }
        if (call.fatal) { state.error = call.error ?? 'The AI service is not available right now.'; return; }
        if (report.ok === true) return;
        if (call.busy && attempt < tries) await steps.sleep(`wait-${page.seq}-${attempt}`, 10 * attempt);
      }
    };

    // Only the first wave waits for the cache; a page that starts later (when an earlier one finished) finds it warm already.
    await pool(first, ports.concurrency, (page, i) => writePage(page, PAGE_TRIES, i > 0 && i < ports.concurrency));

    for (let round = 1; !state.closed && !state.error; round++) {
      if (await ports.beat()) { state.closed = true; break; }
      const v = await op(`verify-${round}`, { op: 'verify', round });
      if (v.closed) { state.closed = true; break; }
      if (v.ok !== true) return { outcome: 'failed', error: String(v.error ?? 'The build could not be checked.') };
      const repairs = Array.isArray(v.repairs) ? v.repairs as PageJob[] : [];
      if (v.final === true || repairs.length === 0) break;
      await pool(repairs, ports.concurrency, (r) => writePage({ seq: r.seq, file: r.file, prompt: r.prompt }, REPAIR_TRIES, false));
    }

    if (state.closed) return { outcome: 'closed' };
    if (state.error) {
      await op('fail', { op: 'fail', error: state.error });
      return { outcome: 'failed', error: state.error };
    }
    await ports.beat();
    const done = await op('complete', { op: 'complete' });
    if (done.closed) return { outcome: 'closed' };
    return done.ok === true ? { outcome: 'complete' } : { outcome: 'failed', error: String(done.error ?? 'The site could not be saved.') };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Close the job so the studio stops waiting — best effort: if even this fails, the heartbeat goes stale and the studio shows the run as dead.
    try {
      await steps.run('fail-crash', { retries: 2, timeout: '2 minutes' }, () => ports.op({ op: 'fail', job_id: jobId, error: 'The build stopped unexpectedly. Please try again.' }));
    } catch { /* nothing more to do */ }
    return { outcome: 'failed', error };
  }
}

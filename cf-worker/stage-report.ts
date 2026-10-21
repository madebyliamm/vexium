// Stage runs (the studio's guided flow, REVAMP Step 7): after the build Worker has streamed a run to the browser it reports the
// outcome to ai-chat, which parses + saves the artifact and closes the job. Doing it HERE (server → server, inside ctx.waitUntil)
// is what lets a run survive a browser refresh: the result is saved whether or not anyone is still listening.
// Kept out of core.ts on purpose — core.ts is the stream parser, with a byte-parity test against ai-chat/index.ts.

export interface StageRunResult {
  ok: boolean;
  message?: string;
  /** The files the run wrote (completed `<file>` blocks). Only sent when there are some — EXAMPLE saves them next to its style. */
  files?: Record<string, string>;
  error?: string;
}

export interface StageOutcome {
  ok: boolean;
  artifact: { kind: string; version: number; staled: string[] } | null;
  error?: string;
}

/**
 * Decide whether a finished stream counts as a successful run. The parser only reports a message once Anthropic said message_stop,
 * so an empty message means the stream was cut — unless the run ended normally (`finished`) after writing files and no chat.
 */
export function judgeRun(r: { aborted: boolean; apiError: string | null; message: string; files?: Record<string, string>; finished?: boolean }): StageRunResult {
  if (r.aborted) return { ok: false, error: 'Stopped' };
  if (r.apiError) return { ok: false, error: r.apiError };
  const hasFiles = !!r.files && Object.keys(r.files).length > 0;
  if (!r.message && !(r.finished && hasFiles)) return { ok: false, error: 'The AI stopped before finishing. Nothing was changed — please try again.' };
  return { ok: true, message: r.message, ...(hasFiles ? { files: r.files } : {}) };
}

/** POST { stage_done } to ai-chat as the user (their own Authorization header). Never throws. */
export async function reportStageDone(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  jobId: string,
  run: StageRunResult,
): Promise<StageOutcome> {
  const unsaved: StageOutcome = { ok: false, artifact: null, error: 'The result could not be saved. Please try again.' };
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage_done: { job_id: jobId, ok: run.ok, message: run.message, files: run.files, error: run.error } }),
    });
    const body = (await res.json().catch(() => null)) as Partial<StageOutcome> & { error?: string } | null;
    if (!res.ok) return { ok: false, artifact: null, error: body?.error || unsaved.error };
    if (!body || typeof body.ok !== 'boolean') return unsaved;
    return { ok: body.ok, artifact: body.artifact ?? null, ...(body.error ? { error: body.error } : {}) };
  } catch {
    return unsaved;
  }
}

/**
 * Stamp the job's heartbeat (service role) and learn whether the run should keep going. The studio treats a 'running' job with no
 * recent heartbeat as dead, and the owner's Stop (or a newer run superseding this one) closes the row — which we notice here and
 * answer by aborting the generation. 'unknown' (network trouble, bad config) never aborts: a hiccup must not kill a good run.
 */
export async function touchJob(doFetch: typeof fetch, supabaseUrl: string, serviceKey: string, jobId: string): Promise<'running' | 'closed' | 'unknown'> {
  if (!supabaseUrl || !serviceKey) return 'unknown';
  try {
    const res = await doFetch(`${supabaseUrl}/rest/v1/build_jobs?id=eq.${encodeURIComponent(jobId)}&status=eq.running&select=id`, {
      method: 'PATCH',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ heartbeat_at: new Date().toISOString() }),
    });
    if (!res.ok) return 'unknown';
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return 'unknown';
    return rows.length > 0 ? 'running' : 'closed';
  } catch {
    return 'unknown';
  }
}

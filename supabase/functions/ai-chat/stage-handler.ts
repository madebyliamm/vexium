// The two stage requests ai-chat answers, with every side effect behind `StageDeps` so the whole flow is unit-tested against an
// in-memory fake (supabase/tests/ai_stages.test.ts). index.ts supplies the real deps (service-role REST) and builds the Anthropic
// payload from the prompt this returns.
//
//   1. { stage, project_id, messages, prepare:true }   → beginStage():  access + inputs + credits checks → creates a build_jobs row
//                                                          → returns the prompt for the build Worker to run (or an HTTP error)
//   2. { stage_done:{ job_id, ok, message, error } }   → finishStageRun(): the Worker reports the finished run; the reply is parsed,
//                                                          validated and saved as an artifact, the job is closed
//
// Why the SERVER saves the result: the run keeps going in the Worker even if the browser refreshes or closes. Saving here means a
// reloaded studio simply finds the new artifact version (and the job row says it finished) — that is resume-after-refresh.
import { isStage, describeBlocker, STAGE_IO, type ArtifactKind, type LatestArtifacts, type Stage } from '../_shared/stages.ts';
import { buildStagePrompt, finishStage, inputBlockers, type StagePrompt } from './stages.ts';

export interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  stage: string | null;
  status: string;
}

export interface StageDeps {
  /** The project's name + current stage if the user owns it or is an ACCEPTED collaborator; null otherwise (not found = no access). */
  getProjectAccess(projectId: string, userId: string): Promise<{ name: string; stage: string } | null>;
  getLatestArtifacts(projectId: string): Promise<LatestArtifacts>;
  /** An error message when the user is out of credits / their trial ended; null when they may run AI. */
  usageGate(userId: string): Promise<string | null>;
  /** Supersedes any older running stage job of the project, then inserts the new one. Returns its id. */
  createJob(job: { project_id: string; user_id: string; stage: Stage; artifact_kind: ArtifactKind | null; prompt: string }): Promise<string>;
  getJob(jobId: string): Promise<JobRow | null>;
  /** Closes a job that is still 'running' (a no-op otherwise). */
  finishJob(jobId: string, patch: { status: 'complete' | 'failed'; error?: string }): Promise<void>;
  /** put_project_artifact as the platform. */
  saveArtifact(projectId: string, kind: ArtifactKind, data: Record<string, unknown>): Promise<{ version: number; staled: string[] }>;
}

export interface HttpError {
  status: number;
  body: { error: string; code: string; [k: string]: unknown };
}
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): HttpError => ({ status, body: { error, code, ...extra } });

export interface StageRequest {
  stage?: unknown;
  project_id?: unknown;
  messages?: unknown;
}

export interface StageRun {
  kind: 'run';
  stage: Stage;
  jobId: string;
  prompt: StagePrompt;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text-only chat history that starts and ends with the user (an Anthropic requirement), or an error string. */
export function cleanMessages(raw: unknown): { role: 'user' | 'assistant'; content: string }[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'messages must be a non-empty list';
  if (raw.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') return 'each message must be an object';
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return 'message role must be user or assistant';
    if (typeof content !== 'string') return 'message content must be text';
    if (content.length > MAX_MESSAGE_CHARS) return `a message is too long (max ${MAX_MESSAGE_CHARS} characters)`;
    out.push({ role, content });
  }
  if (out[0]!.role !== 'user') return 'the conversation must start with a user message';
  if (out[out.length - 1]!.role !== 'user') return 'the last message must come from the user';
  return out;
}

export async function beginStage(body: StageRequest, userId: string, deps: StageDeps): Promise<StageRun | HttpError> {
  if (!isStage(body.stage)) return fail(400, 'bad_stage', 'Unknown stage.');
  const stage = body.stage;
  if (typeof body.project_id !== 'string' || !body.project_id || body.project_id.length > 200) return fail(400, 'bad_project', 'project_id is required.');
  const projectId = body.project_id;
  const messages = cleanMessages(body.messages);
  if (typeof messages === 'string') return fail(400, 'bad_messages', messages);

  const project = await deps.getProjectAccess(projectId, userId);
  if (!project) return fail(404, 'not_found', 'Project not found.');

  const latest = await deps.getLatestArtifacts(projectId);
  const blocked = inputBlockers(stage, latest);
  if (blocked.length) {
    return fail(409, 'stage_inputs', blocked.map(describeBlocker).join('. ') + '.', { blocked_by: blocked });
  }

  const limit = await deps.usageGate(userId);
  if (limit) return fail(402, 'usage_limit', limit);

  const prompt = buildStagePrompt(stage, latest, { projectName: project.name });
  const lastUser = messages[messages.length - 1]!.content;
  const jobId = await deps.createJob({
    project_id: projectId,
    user_id: userId,
    stage,
    artifact_kind: STAGE_IO[stage].produces,
    prompt: lastUser.slice(0, 500),
  });
  return { kind: 'run', stage, jobId, prompt, messages };
}

export interface StageDoneRequest {
  job_id?: unknown;
  ok?: unknown;
  message?: unknown;
  error?: unknown;
}

export interface StageOutcome {
  ok: boolean;
  /** What was saved (null for a chat-only turn or a failure). */
  artifact: { kind: ArtifactKind; version: number; staled: string[] } | null;
  error?: string;
}

const MAX_REPLY_CHARS = 400_000;

/**
 * `fromWorker` = the request carried the build Worker's secret (index.ts compares it to the service key). Only the Worker may report
 * a finished run: the reply text becomes an artifact (even a platform-only kind like the manifest), so if the user's own token were
 * enough, a client could `prepare` a run on its own and then "report" any text it likes.
 */
export async function finishStageRun(body: StageDoneRequest, userId: string, deps: StageDeps, fromWorker: boolean): Promise<{ status: 200; body: StageOutcome } | HttpError> {
  if (!fromWorker) return fail(403, 'forbidden', 'Only the build service can report a finished run.');
  if (typeof body.job_id !== 'string' || !UUID.test(body.job_id)) return fail(400, 'bad_job', 'job_id is required.');
  const job = await deps.getJob(body.job_id);
  // A job that isn't yours, or isn't a stage job (the old editor's rows have stage = null), looks like it doesn't exist.
  if (!job || job.user_id !== userId || !isStage(job.stage)) return fail(404, 'not_found', 'Job not found.');
  if (job.status !== 'running') return fail(409, 'job_closed', 'This run has already finished.');
  const stage: Stage = job.stage;

  const close = async (status: 'complete' | 'failed', error?: string): Promise<void> => {
    await deps.finishJob(job.id, error === undefined ? { status } : { status, error: error.slice(0, 500) });
  };

  if (body.ok !== true) {
    const error = typeof body.error === 'string' && body.error ? body.error : 'The run did not finish.';
    await close('failed', error);
    return { status: 200, body: { ok: false, artifact: null, error } };
  }
  if (typeof body.message !== 'string') {
    await close('failed', 'The AI sent no reply.');
    return { status: 200, body: { ok: false, artifact: null, error: 'The AI sent no reply.' } };
  }
  if (body.message.length > MAX_REPLY_CHARS) return fail(413, 'too_large', 'The reply is too large to save.');

  // Access may have been removed while the run was going (collaborator removed): then nothing is saved.
  if (!(await deps.getProjectAccess(job.project_id, userId))) {
    await close('failed', 'No access to this project any more.');
    return fail(404, 'not_found', 'Project not found.');
  }

  const done = finishStage(stage, body.message);
  if (done.error) {
    await close('failed', done.error);
    return { status: 200, body: { ok: false, artifact: null, error: done.error } };
  }
  if (!done.artifact) {
    await close('complete');
    return { status: 200, body: { ok: true, artifact: null } };
  }
  try {
    const saved = await deps.saveArtifact(job.project_id, done.artifact.kind, done.artifact.data);
    await close('complete');
    return { status: 200, body: { ok: true, artifact: { kind: done.artifact.kind, version: saved.version, staled: saved.staled } } };
  } catch (e) {
    const error = 'The result could not be saved. Please try again.';
    await close('failed', `${error} (${e instanceof Error ? e.message : String(e)})`);
    return { status: 200, body: { ok: false, artifact: null, error } };
  }
}

/** The owner's Stop button: close the job. The build Worker notices on its next heartbeat and aborts the generation. Idempotent. */
export async function cancelStageRun(body: { job_id?: unknown }, userId: string, deps: StageDeps): Promise<{ status: 200; body: { ok: true } } | HttpError> {
  if (typeof body.job_id !== 'string' || !UUID.test(body.job_id)) return fail(400, 'bad_job', 'job_id is required.');
  const job = await deps.getJob(body.job_id);
  if (!job || job.user_id !== userId || !isStage(job.stage)) return fail(404, 'not_found', 'Job not found.');
  if (job.status === 'running') await deps.finishJob(job.id, { status: 'failed', error: 'Stopped' });
  return { status: 200, body: { ok: true } };
}

/** An error response (status ≥ 400). finishStageRun's normal result is also {status, body}, with status 200. */
export function isHttpError(x: unknown): x is HttpError {
  return !!x && typeof x === 'object' && typeof (x as { status?: unknown }).status === 'number' && (x as { status: number }).status >= 400;
}

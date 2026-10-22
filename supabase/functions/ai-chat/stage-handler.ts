// The two stage requests ai-chat answers, with every side effect behind `StageDeps` so the whole flow is unit-tested against an
// in-memory fake (supabase/tests/ai_stages.test.ts). index.ts supplies the real deps (service-role REST) and builds the Anthropic
// payload from the prompt this returns.
//
//   1. { stage, project_id, messages, prepare:true }   → beginStage():  access + inputs + credits checks → creates a build_jobs row
//                                                          → returns the prompt for the build Worker to run (or an HTTP error)
//   2. { stage_done:{ job_id, ok, message, files?, error } } → finishStageRun(): the Worker reports the finished run; the reply (and,
//                                                          for EXAMPLE, the files it wrote) is parsed, validated and saved — files first,
//                                                          then the artifact — and the job is closed
//
// Why the SERVER saves the result: the run keeps going in the Worker even if the browser refreshes or closes. Saving here means a
// reloaded studio simply finds the new artifact version (and the job row says it finished) — that is resume-after-refresh.
import { isStage, describeBlocker, STAGE_IO, type ArtifactKind, type LatestArtifacts, type Stage } from '../_shared/stages.ts';
import { takeCheckpoint, type CheckpointDeps } from './checkpoints.ts';
import { buildStagePrompt, finishStage, inputBlockers, type StagePrompt } from './stages.ts';
import { applyTweak } from './tweaks-handler.ts';
import { cleanPointed, tweakContext, type Pointed } from './tweaks-prompt.ts';

export interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  stage: string | null;
  status: string;
  /** What the owner typed to start the run (first 500 characters) — FULL BUILD reads it back as the owner's note. */
  prompt?: string | null;
}

export interface StageDeps extends CheckpointDeps {
  /** The project's name + current stage if the user owns it or is an ACCEPTED collaborator; null otherwise (not found = no access). */
  getProjectAccess(projectId: string, userId: string): Promise<{ name: string; stage: string } | null>;
  getLatestArtifacts(projectId: string): Promise<LatestArtifacts>;
  /** projects.files as it is now: name → text (non-text values are left out). */
  getProjectFiles(projectId: string): Promise<Record<string, string>>;
  /** An error message when the user is out of credits / their trial ended; null when they may run AI. */
  usageGate(userId: string): Promise<string | null>;
  /** Supersedes any older running stage job of the project, then inserts the new one. Returns its id. */
  createJob(job: { project_id: string; user_id: string; stage: Stage; artifact_kind: ArtifactKind | null; prompt: string }): Promise<string>;
  getJob(jobId: string): Promise<JobRow | null>;
  /** Closes a job that is still 'running' (a no-op otherwise). */
  finishJob(jobId: string, patch: { status: 'complete' | 'failed'; error?: string }): Promise<void>;
  /** put_project_artifact as the platform. */
  saveArtifact(projectId: string, kind: ArtifactKind, data: Record<string, unknown>): Promise<{ version: number; staled: string[] }>;
  /** set_project_files as the platform: merges the given site files into projects.files in one statement (other files are kept). */
  saveFiles(projectId: string, files: Record<string, string>): Promise<void>;
  /** The newest saved line of this stage's chat, or null when there is none. */
  lastMessage(projectId: string, stage: Stage): Promise<{ role: 'user' | 'assistant'; content: string } | null>;
  /** Appends a line to the stage's chat (stage_messages — written by the platform only). */
  saveMessage(m: { project_id: string; stage: Stage; role: 'user' | 'assistant'; content: string; user_id: string | null; job_id: string }): Promise<void>;
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
  /** TWEAKS: the element the owner pointed at in the preview (untrusted — cleanPointed). */
  pointed?: unknown;
}

export interface StageRun {
  kind: 'run';
  stage: Stage;
  jobId: string;
  prompt: StagePrompt;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** TWEAKS: the site's text files the run may patch (name → text). The Worker applies the model's patches to exactly these. */
  filesForPatching?: Record<string, string>;
}

/** FULL BUILD is not one model call but a Cloudflare Workflow of many (build-handler.ts): the Worker is told only which job to run. */
export interface StageWorkflow {
  kind: 'workflow';
  stage: Stage;
  jobId: string;
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

export async function beginStage(body: StageRequest, userId: string, deps: StageDeps): Promise<StageRun | StageWorkflow | HttpError> {
  if (!isStage(body.stage)) return fail(400, 'bad_stage', 'Unknown stage.');
  const stage = body.stage;
  if (typeof body.project_id !== 'string' || !body.project_id || body.project_id.length > 200) return fail(400, 'bad_project', 'project_id is required.');
  const projectId = body.project_id;
  const messages = cleanMessages(body.messages);
  if (typeof messages === 'string') return fail(400, 'bad_messages', messages);
  const pointed = stage === 'tweaks' ? cleanPointed(body.pointed) : null;
  if (typeof pointed === 'string') return fail(400, 'bad_pointed', pointed);

  const project = await deps.getProjectAccess(projectId, userId);
  if (!project) return fail(404, 'not_found', 'Project not found.');

  const latest = await deps.getLatestArtifacts(projectId);
  const blocked = inputBlockers(stage, latest);
  // A tweak changes the BUILT site: besides the plan and the locked style (the stage's inputs), the build must exist.
  if (stage === 'tweaks' && !latest.manifest) blocked.push({ kind: 'manifest', reason: 'missing' });
  if (blocked.length) {
    return fail(409, 'stage_inputs', blocked.map(describeBlocker).join('. ') + '.', { blocked_by: blocked });
  }

  const limit = await deps.usageGate(userId);
  if (limit) return fail(402, 'usage_limit', limit);

  const lastUser = messages[messages.length - 1]!.content;
  const jobId = await deps.createJob({
    project_id: projectId,
    user_id: userId,
    stage,
    artifact_kind: STAGE_IO[stage].produces,
    prompt: lastUser.slice(0, 500),
  });
  await recordUserLine(deps, { projectId, stage, userId, jobId, content: lastUser });
  if (stage === 'build') return { kind: 'workflow', stage, jobId };
  if (stage === 'tweaks') return await beginTweak({ projectName: project.name, projectId, jobId, latest, messages, pointed }, deps);
  return { kind: 'run', stage, jobId, prompt: buildStagePrompt(stage, latest, { projectName: project.name }), messages };
}

/** A tweak run: the checkpoint "before your changes", then the prompt with the site's current text and the chosen element. */
async function beginTweak(
  i: { projectName: string; projectId: string; jobId: string; latest: LatestArtifacts; messages: StageRun['messages']; pointed: Pointed | null },
  deps: StageDeps,
): Promise<StageRun> {
  const files = await deps.getProjectFiles(i.projectId);
  // The site as the owner has it now, kept so that an undo can come back to it (nothing is taken when it is already the newest checkpoint).
  await takeCheckpoint(deps, i.projectId, 'baseline', 'Before your changes');
  const manifest = i.latest.manifest!.data as { pages?: { file?: unknown; title?: unknown }[] };
  const pages = (manifest.pages ?? []).filter((p) => typeof p.file === 'string').map((p) => ({ file: String(p.file), title: typeof p.title === 'string' ? p.title : String(p.file) }));
  const context = tweakContext({ files, pages, pointed: i.pointed });
  const filesForPatching: Record<string, string> = {};
  for (const name of context.shown) filesForPatching[name] = files[name]!;
  return { kind: 'run', stage: 'tweaks', jobId: i.jobId, prompt: buildStagePrompt('tweaks', i.latest, { projectName: i.projectName, extra: context.text }), messages: i.messages, filesForPatching };
}

const MAX_LINE_CHARS = 20_000;

/**
 * Keep the stage's chat on the server so a refresh (or another device) restores it. A retry of a message that never got an answer
 * (the last saved line is that same user message) is not saved twice. History is a convenience: failing to write it never fails a run.
 */
async function recordUserLine(deps: StageDeps, l: { projectId: string; stage: Stage; userId: string; jobId: string; content: string }): Promise<void> {
  try {
    const last = await deps.lastMessage(l.projectId, l.stage);
    if (last && last.role === 'user' && last.content === l.content) return;
    await deps.saveMessage({ project_id: l.projectId, stage: l.stage, role: 'user', content: l.content.slice(0, MAX_LINE_CHARS), user_id: l.userId, job_id: l.jobId });
  } catch (e) {
    console.error('[ai-chat] could not save the stage chat line', e);
  }
}

const KIND_WORDS: Record<ArtifactKind, string> = { plan: 'plan', style_spec: 'style', manifest: 'built site', launch_checks: 'launch check', business_state: 'business data' };

export interface StageDoneRequest {
  job_id?: unknown;
  ok?: unknown;
  message?: unknown;
  /** The files the run wrote (completed `<file>` blocks), name → text. Only stages that produce files use them (EXAMPLE). */
  files?: unknown;
  /** How many patch blocks matched nothing in the file they named (counted by the Worker; TWEAKS refuses the change when any did). */
  patch_failed?: unknown;
  error?: unknown;
}

const MAX_FILES = 40;

/** `files` from the Worker → a plain name → text map, or an error string. Anything that is not text is refused outright. */
function cleanFiles(raw: unknown): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'files must be an object of name → text';
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_FILES) return `too many files (max ${MAX_FILES})`;
  const out: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (typeof text !== 'string') return `file ${name.slice(0, 60)} must be text`;
    out[name] = text;
  }
  return out;
}

export interface StageOutcome {
  ok: boolean;
  /** What was saved (null for a chat-only turn or a failure). */
  artifact: { kind: ArtifactKind; version: number; staled: string[] } | null;
  /** TWEAKS: the files the change touched. */
  changed?: string[];
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
  const written = cleanFiles(body.files);
  if (typeof written === 'string') {
    await close('failed', 'The run sent files that could not be read.');
    return fail(400, 'bad_files', written);
  }

  // Access may have been removed while the run was going (collaborator removed): then nothing is saved.
  if (!(await deps.getProjectAccess(job.project_id, userId))) {
    await close('failed', 'No access to this project any more.');
    return fail(404, 'not_found', 'Project not found.');
  }

  if (stage === 'tweaks') {
    const pf = typeof body.patch_failed === 'number' && Number.isFinite(body.patch_failed) ? Math.max(0, Math.floor(body.patch_failed)) : 0;
    const t = await applyTweak({ projectId: job.project_id, request: job.prompt ?? '', message: body.message, written, patchFailed: pf }, deps);
    if (!t.ok) {
      await close('failed', t.error ?? 'The change was not made.');
      return { status: 200, body: { ok: false, artifact: null, error: t.error ?? 'The change was not made.' } };
    }
    if (t.chat) {
      try {
        await deps.saveMessage({ project_id: job.project_id, stage, role: 'assistant', content: t.chat.slice(0, MAX_LINE_CHARS), user_id: null, job_id: job.id });
      } catch (e) {
        console.error('[ai-chat] could not save the stage reply', e);
      }
    }
    await close('complete');
    return { status: 200, body: { ok: true, artifact: t.artifact, changed: t.changed } };
  }

  const done = finishStage(stage, body.message, written);
  if (done.error) {
    await close('failed', done.error);
    return { status: 200, body: { ok: false, artifact: null, error: done.error } };
  }
  const recordReply = async (chat: string): Promise<void> => {
    if (!chat) return;
    try {
      await deps.saveMessage({ project_id: job.project_id, stage, role: 'assistant', content: chat.slice(0, MAX_LINE_CHARS), user_id: null, job_id: job.id });
    } catch (e) {
      console.error('[ai-chat] could not save the stage reply', e);
    }
  };
  if (!done.artifact) {
    await recordReply(done.chat);
    await close('complete');
    return { status: 200, body: { ok: true, artifact: null } };
  }
  try {
    // Files first, then the artifact: a new artifact version is what tells the studio "the run is done", so by then the files are there.
    if (done.files) await deps.saveFiles(job.project_id, done.files);
    if (done.files && stage === 'example') await takeCheckpoint(deps, job.project_id, 'stage', 'Example page');
    const saved = await deps.saveArtifact(job.project_id, done.artifact.kind, done.artifact.data);
    // The reply is only worth keeping once what it describes was actually saved (otherwise it claims changes that never happened).
    await recordReply(done.chat || (done.files ? "Here's your landing page." : `I've updated your ${KIND_WORDS[done.artifact.kind]}.`));
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

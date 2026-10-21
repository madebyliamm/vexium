// The stage engine over Supabase: read a project's stage + latest artifacts + last stage run, save/keep artifacts, move the stage.
// Writes go through the SECURITY DEFINER RPCs (put_project_artifact / keep_project_artifact / set_project_stage) — the tables
// themselves are read-only for clients (RLS). Pure logic lives in lib/stages.ts + lib/stage-view.ts (unit-tested); this file is I/O.
import { AI_EDGE_URL } from '../lib/config.ts';
import { sb } from '../lib/supabase.ts';
import { authDeps } from './deps.ts';
import { postJson } from './http.ts';
import { toChatLine, type ChatLine } from '../lib/plan-view.ts';
import { describeStageError, parseJob, parseMoveResult, rowsToLatest, type MoveOutcome, type StageJob } from '../lib/stage-view.ts';
import { isStage, type ArtifactKind, type LatestArtifacts, type Stage } from '../lib/stages.ts';

export class StageError extends Error {
  readonly code: string | null;
  constructor(err: { code?: string | null; message?: string | null }) {
    super(describeStageError(err));
    this.name = 'StageError';
    this.code = err.code ?? null;
  }
}

export interface StageProject {
  id: string;
  name: string;
  emoji: string | null;
  stage: Stage;
  /** A live Hosting v2 deploy exists (BUSINESS needs it). */
  published: boolean;
}

export interface StageState {
  project: StageProject;
  artifacts: LatestArtifacts;
  /** The most recent stage run of this project (any status), or null. */
  job: StageJob | null;
}

const ARTIFACT_COLUMNS = 'kind,version,stale,data';
const JOB_COLUMNS = 'id,stage,status,created_at,heartbeat_at,finished_at,error';

/** Everything the project page needs, in one round trip. null = no such project / no access (RLS hides it). */
export async function getStageState(projectId: string): Promise<StageState | null> {
  const [project, artifacts, job] = await Promise.all([
    sb.from('projects').select('id,name,emoji,stage,published_version').eq('id', projectId).maybeSingle(),
    sb.from('project_artifacts_latest').select(ARTIFACT_COLUMNS).eq('project_id', projectId),
    sb.from('build_jobs').select(JOB_COLUMNS).eq('project_id', projectId).not('stage', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (project.error) throw new Error(project.error.message);
  if (artifacts.error) throw new Error(artifacts.error.message);
  if (job.error) throw new Error(job.error.message);
  if (!project.data) return null;
  const p = project.data as { id: string; name: string | null; emoji: string | null; stage: unknown; published_version: number | null };
  return {
    project: { id: p.id, name: p.name ?? '', emoji: p.emoji, stage: isStage(p.stage) ? p.stage : 'plan', published: p.published_version != null },
    artifacts: rowsToLatest(artifacts.data ?? []),
    job: parseJob(job.data),
  };
}

/** The latest stage run only (cheap; used to poll while a run is going). */
export async function getLatestStageJob(projectId: string): Promise<StageJob | null> {
  const { data, error } = await sb.from('build_jobs').select(JOB_COLUMNS).eq('project_id', projectId).not('stage', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return parseJob(data);
}

/** Save a new version of a plan / style (the kinds a member may write). `expectedVersion` guards against a concurrent edit (409). */
export async function saveArtifact(projectId: string, kind: ArtifactKind, data: Record<string, unknown>, expectedVersion?: number): Promise<{ version: number; staled: ArtifactKind[] }> {
  const { data: out, error } = await sb.rpc('put_project_artifact', {
    p_project: projectId,
    p_kind: kind,
    p_data: data,
    ...(expectedVersion !== undefined ? { p_expected_version: expectedVersion } : {}),
  });
  if (error) throw new StageError(error);
  const o = out as { version: number; staled?: ArtifactKind[] };
  return { version: o.version, staled: o.staled ?? [] };
}

/** "Still fine, keep it" on a stale plan / style / built site. */
export async function keepArtifact(projectId: string, kind: ArtifactKind): Promise<boolean> {
  const { data, error } = await sb.rpc('keep_project_artifact', { p_project: projectId, p_kind: kind });
  if (error) throw new StageError(error);
  return (data as { cleared?: boolean } | null)?.cleared === true;
}

/** Move to another stage. A refusal is a normal result (`ok:false` + why); only real failures throw. */
export async function moveToStage(projectId: string, stage: Stage): Promise<MoveOutcome> {
  const { data, error } = await sb.rpc('set_project_stage', { p_project: projectId, p_stage: stage });
  if (error) throw new StageError(error);
  return parseMoveResult(data);
}

/** The Stop button: closes the run's job; the build Worker notices on its next heartbeat (≤ ~8 s) and stops generating. */
export async function cancelStageRun(jobId: string): Promise<void> {
  await postJson(AI_EDGE_URL, { stage_cancel: { job_id: jobId } }, authDeps);
}

/** The saved chat of one stage, oldest first (the newest 100 lines). Written by the platform only — see stage_messages. */
export async function listStageMessages(projectId: string, stage: Stage): Promise<ChatLine[]> {
  const { data, error } = await sb.from('stage_messages').select('id,role,content,created_at').eq('project_id', projectId).eq('stage', stage).order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toChatLine).filter((l): l is ChatLine => l !== null).reverse();
}

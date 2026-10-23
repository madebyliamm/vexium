// Framework-free view logic for the project page: what the stepper shows, how Supabase rows become engine state, how a stage
// run is judged "still going". Pure (unit-tested under Node, test/stage-view.test.ts); api/stages.ts does the I/O.
import {
  STAGES, STAGE_IO, STAGE_LABELS, blockers, canMoveTo, clientMayKeep, isArtifactKind, isStage, stageRank,
  type ArtifactKind, type Blocker, type BlockerKind, type BlockerReason, type LatestArtifacts, type Stage,
} from './stages.ts';

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  plan: 'Plan',
  style_spec: 'Style',
  manifest: 'Built site',
  launch_checks: 'Launch check',
  business_state: 'Business data',
};

export const STAGE_BLURBS: Record<Stage, string> = {
  plan: 'Turn the idea into a concrete plan: who it is for, what you offer, which pages, what only you can supply.',
  example: 'See your landing page and pick the look — colors, fonts, tone. Lock it when it feels right.',
  build: 'Build the whole site from your plan, in your locked style, with no placeholder content.',
  tweaks: 'Point at anything in the preview and say what to change.',
  launch: 'Run the final checks, then put it live on your own address.',
  business: 'See how it is doing next to your plan, get suggestions you can apply in one click, and change it any time.',
};

/** A row of `project_artifacts_latest` (explicit columns) → the engine's LatestArtifacts. Unknown kinds and non-object data are ignored. */
export function rowsToLatest(rows: readonly { kind?: unknown; version?: unknown; stale?: unknown; data?: unknown }[]): LatestArtifacts {
  const out: LatestArtifacts = {};
  for (const r of rows) {
    if (!isArtifactKind(r.kind) || typeof r.version !== 'number') continue;
    const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : {};
    out[r.kind] = { version: r.version, stale: r.stale === true, data };
  }
  return out;
}

export interface MoveOutcome {
  ok: boolean;
  stage: Stage;
  blockedBy: Blocker[];
}

/** The jsonb `set_project_stage` returns → MoveOutcome. Throws on a shape the engine can't have produced. */
export function parseMoveResult(raw: unknown): MoveOutcome {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.ok !== 'boolean' || !isStage(o.stage)) throw new Error('Unexpected answer from the server');
  const list = Array.isArray(o.blocked_by) ? o.blocked_by : [];
  const blockedBy: Blocker[] = [];
  for (const b of list) {
    const x = b as { kind?: unknown; reason?: unknown } | null;
    if (!x || typeof x.reason !== 'string' || typeof x.kind !== 'string') continue;
    if (x.kind !== 'published' && !isArtifactKind(x.kind)) continue;
    blockedBy.push({ kind: x.kind as BlockerKind, reason: x.reason as BlockerReason });
  }
  return { ok: o.ok, stage: o.stage, blockedBy };
}

/** PostgREST/RPC error → something a person can read. */
export function describeStageError(err: { code?: string | null; message?: string | null }): string {
  switch (err.code) {
    case 'PT409':
    case '40001':
      return 'This was changed somewhere else a moment ago. Reload to see the latest version.';
    case '42501':
      return "You don't have access to do that.";
    case '54000':
      return 'That is too large to save.';
    default:
      return err.message?.trim() || 'Something went wrong. Please try again.';
  }
}

export type JobStatus = 'running' | 'complete' | 'failed';

export interface StageJob {
  id: string;
  stage: Stage;
  status: JobStatus;
  created_at: string;
  /** Stamped by the build Worker every ~8 s while the run is alive. */
  heartbeat_at: string | null;
  finished_at: string | null;
  error: string | null;
}

/** A `build_jobs` row of a stage run → StageJob, or null for the old editor's rows (no stage) and junk. */
export function parseJob(row: unknown): StageJob | null {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
  if (!r || typeof r.id !== 'string' || !isStage(r.stage)) return null;
  if (r.status !== 'running' && r.status !== 'complete' && r.status !== 'failed') return null;
  if (typeof r.created_at !== 'string') return null;
  return {
    id: r.id,
    stage: r.stage,
    status: r.status,
    created_at: r.created_at,
    heartbeat_at: typeof r.heartbeat_at === 'string' ? r.heartbeat_at : null,
    finished_at: typeof r.finished_at === 'string' ? r.finished_at : null,
    error: typeof r.error === 'string' && r.error ? r.error : null,
  };
}

/** The Worker stamps a heartbeat every ~8 s. A 'running' job with none for this long is dead (the Worker was killed). */
export const JOB_LIVE_MS = 45 * 1000;
/** A failed run is worth mentioning for a while, not forever. */
export const JOB_FAILED_SHOWN_MS = 60 * 60 * 1000;

export function jobIsLive(job: StageJob | null, now: number = Date.now()): boolean {
  if (!job || job.status !== 'running') return false;
  const t = Date.parse(job.heartbeat_at ?? job.created_at);
  return !Number.isNaN(t) && now - t < JOB_LIVE_MS;
}

export function jobFailedRecently(job: StageJob | null, now: number = Date.now()): boolean {
  if (!job || job.status !== 'failed' || !job.error) return false;
  const t = Date.parse(job.finished_at ?? job.created_at);
  return !Number.isNaN(t) && now - t < JOB_FAILED_SHOWN_MS;
}

export type StepState = 'current' | 'past' | 'open' | 'blocked';

export interface Step {
  stage: Stage;
  label: string;
  n: number;
  state: StepState;
  /** Why it can't be entered (state 'blocked' only). */
  blockedBy: Blocker[];
  /** The artifact this stage produces is out of date — worth a look. */
  attention: boolean;
}

/** The stepper: one entry per stage, from the project's current stage and its artifacts. */
export function buildSteps(current: Stage, latest: LatestArtifacts, published: boolean): Step[] {
  return STAGES.map((stage) => {
    const produces = STAGE_IO[stage].produces;
    const attention = !!produces && latest[produces]?.stale === true;
    let state: StepState;
    let blockedBy: Blocker[] = [];
    if (stage === current) state = 'current';
    else if (stageRank(stage) < stageRank(current)) state = 'past';
    else {
      const move = canMoveTo(current, stage, latest, published);
      state = move.ok ? 'open' : 'blocked';
      blockedBy = move.blockedBy;
    }
    return { stage, label: STAGE_LABELS[stage], n: stageRank(stage) + 1, state, blockedBy, attention };
  });
}

export interface ArtifactCard {
  kind: ArtifactKind;
  label: string;
  role: 'input' | 'working';
  /** null = not made yet */
  version: number | null;
  stale: boolean;
  /** The member may mark this stale artifact "still fine". */
  keepable: boolean;
}

/** The artifacts a stage reads (inputs) and works on, in the order the engine lists them, with their current state. */
export function artifactCards(stage: Stage, latest: LatestArtifacts): ArtifactCard[] {
  const io = STAGE_IO[stage];
  const kinds: { kind: ArtifactKind; role: 'input' | 'working' }[] = io.inputs.map((kind) => ({ kind, role: 'input' as const }));
  if (io.worksOn && !io.inputs.includes(io.worksOn)) kinds.push({ kind: io.worksOn, role: 'working' });
  return kinds.map(({ kind, role }) => {
    const a = latest[kind];
    return { kind, label: ARTIFACT_LABELS[kind], role, version: a?.version ?? null, stale: a?.stale === true, keepable: a?.stale === true && clientMayKeep(kind) };
  });
}

/** What's in the way of the "continue" button (the next stage), already worded for a person. */
export function continueBlockers(current: Stage, latest: LatestArtifacts, published: boolean): Blocker[] {
  const next = STAGES[stageRank(current) + 1];
  return next ? blockers(next, latest, published) : [];
}

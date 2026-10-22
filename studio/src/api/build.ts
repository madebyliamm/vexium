// FULL BUILD over the network (REVAMP Step 10): start a build, follow its checklist, re-run the launch checks, read the built site's files.
// Pure logic lives in lib/build-view.ts (unit-tested); this file is I/O.
//
// Unlike PLAN/EXAMPLE, a build does not stream: the Worker starts a Workflow and answers at once with the job id, and the screen follows
// the job's `build_steps` rows by polling. That is what lets a build outlive the browser tab.
import { AI_BUILD_URL, AI_EDGE_URL } from '../lib/config.ts';
import { buildMessage, previewFileNames, previewFilesFromRow, previewSelect, readSteps, STEP_COLUMNS, type SitePage, type StepRow } from '../lib/build-view.ts';
import { parseJob, type StageJob } from '../lib/stage-view.ts';
import { sb } from '../lib/supabase.ts';
import { authDeps } from './deps.ts';
import { postJson } from './http.ts';

/** Start a build. The Worker has created the job and the Workflow that runs it by the time this returns. */
export async function startBuild(projectId: string, note: string): Promise<{ jobId: string }> {
  const out = await postJson<{ ok?: boolean; job_id?: unknown }>(
    AI_BUILD_URL,
    { stage: 'build', project_id: projectId, messages: [{ role: 'user', content: buildMessage(note) }], stream: true },
    authDeps,
  );
  if (typeof out.job_id !== 'string' || !out.job_id) throw new Error('The build did not start. Please try again.');
  return { jobId: out.job_id };
}

export interface BuildProgress {
  job: StageJob | null;
  steps: StepRow[];
}

const JOB_COLUMNS = 'id,stage,status,created_at,heartbeat_at,finished_at,error';

/** The newest build run of the project and its checklist (`build_steps` rows; their page text is not readable by clients). */
export async function getBuildProgress(projectId: string): Promise<BuildProgress> {
  const j = await sb.from('build_jobs').select(JOB_COLUMNS).eq('project_id', projectId).eq('stage', 'build').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (j.error) throw new Error(j.error.message);
  const job = parseJob(j.data);
  if (!job) return { job: null, steps: [] };
  const s = await sb.from('build_steps').select(STEP_COLUMNS).eq('job_id', job.id).order('seq', { ascending: true }).limit(200);
  if (s.error) throw new Error(s.error.message);
  return { job, steps: readSteps(s.data) };
}

/** "Check again": the server re-runs the launch checks on the site as it is saved now and saves a fresh report. */
export async function recheckSite(projectId: string): Promise<{ ok: boolean; error?: string }> {
  return await postJson<{ ok: boolean; error?: string }>(AI_EDGE_URL, { stage: 'build', build_recheck: { project_id: projectId } }, authDeps);
}

/** The built pages plus styles.css and site.js as text, for the preview. Empty-string / missing files are left out. */
export async function getSiteFiles(projectId: string, pages: readonly SitePage[]): Promise<Record<string, string>> {
  const names = previewFileNames(pages);
  const { data, error } = await sb.from('projects').select(previewSelect(names)).eq('id', projectId).maybeSingle();
  if (error) throw new Error(error.message);
  return previewFilesFromRow(names, data);
}

// TWEAKS (REVAMP Step 11) — the I/O around tweaks.ts, with every side effect behind deps so the flow is unit-tested against an
// in-memory fake (supabase/tests/tweaks.test.ts):
//
//   applyTweak   a finished tweak run (called by finishStageRun): judge it, save the files, take a checkpoint, save the style and the
//                launch report. A tweak that fails any check saves nothing at all.
//   moveHistory  the owner's undo / redo / "go back to this version": move along the site's checkpoints (the database does the move
//                atomically), keep the style and the launch report in step with the files that are back, and cancel any run in flight
//                so its result cannot land on top of the version the owner just chose.
//
// "Edits stay draft until published": a tweak writes projects.files only. The published site is a separate, versioned copy in R2
// (the Publisher Worker), so nothing here reaches visitors until the owner publishes.
import { manifestWithStyle } from '../_shared/style.ts';
import { inputsFrom, saveLaunchReport, verifyStored } from './build-handler.ts';
import { requestLabel, takeCheckpoint } from './checkpoints.ts';
import type { StageDeps } from './stage-handler.ts';
import { canonicalJson } from './stages.ts';
import { finishTweaks, styleMoved } from './tweaks.ts';

/** The same JSON, whatever its spacing and key order? */
const sameJson = (a: string, b: string): boolean => {
  try {
    return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
  } catch {
    return a === b;
  }
};

export type TweakDeps = Pick<StageDeps, 'getLatestArtifacts' | 'getProjectFiles' | 'saveArtifact' | 'saveFiles' | 'snapshot'>;

export interface TweakDone {
  ok: boolean;
  /** Plain English; set when ok is false. */
  error?: string;
  /** What to show in the chat. */
  chat: string;
  /** What was saved: the new launch report (null for a chat-only turn, or when the report could not be refreshed). */
  artifact: { kind: 'launch_checks'; version: number; staled: string[] } | null;
  /** The files that changed. */
  changed: string[];
}

const FALLBACK_CHAT = 'Done — the change is in your draft. Publish when you want visitors to see it.';

export async function applyTweak(i: { projectId: string; request: string; message: string; written: Record<string, string>; patchFailed: number }, deps: TweakDeps): Promise<TweakDone> {
  const files = await deps.getProjectFiles(i.projectId);
  const latest = await deps.getLatestArtifacts(i.projectId);
  const r = finishTweaks({ message: i.message, written: i.written, patchFailed: i.patchFailed, files, latest });
  if (r.error) return { ok: false, error: r.error, chat: r.chat, artifact: null, changed: [] };
  const changed = Object.keys(r.files);
  if (changed.length === 0) return { ok: true, chat: r.chat || "I didn't change anything.", artifact: null, changed };

  try {
    // Files first, then the checkpoint (the history holds the site as it now is), then the artifacts.
    await deps.saveFiles(i.projectId, r.files);
  } catch (e) {
    console.error('[ai-chat] tweak: could not save the files', e);
    return { ok: false, error: 'The change could not be saved. Please try again. Nothing was changed.', chat: r.chat, artifact: null, changed: [] };
  }
  await takeCheckpoint(deps, i.projectId, 'tweak', requestLabel(i.request));

  const chat = r.chat || FALLBACK_CHAT;
  try {
    let manifestVersion = latest.manifest!.version;
    if (r.style) {
      // A new style marks the built site and its report out of date; the site itself was just updated to match, so it is saved again as current.
      await deps.saveArtifact(i.projectId, 'style_spec', r.style as unknown as Record<string, unknown>);
      manifestVersion = (await deps.saveArtifact(i.projectId, 'manifest', latest.manifest!.data)).version;
    }
    const version = await saveLaunchReport(deps, i.projectId, r.report!, manifestVersion);
    if (typeof version === 'string') throw new Error(version);
    return { ok: true, chat, artifact: { kind: 'launch_checks', version, staled: [] }, changed };
  } catch (e) {
    console.error('[ai-chat] tweak: could not refresh the artifacts', e);
    return { ok: true, chat: `${chat} (The launch check could not be refreshed — use "Check again".)`, artifact: null, changed };
  }
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────

export type HistoryAction = 'undo' | 'redo' | 'restore';
export type MoveResult = { moved: true; seq: number; kind: string; label: string } | { moved: false; reason: string; seq?: number };

export interface HistoryDeps extends Pick<StageDeps, 'getProjectAccess' | 'getLatestArtifacts' | 'getProjectFiles' | 'saveArtifact' | 'saveFiles'> {
  /** move_site_history as the platform. */
  moveHistory(projectId: string, action: HistoryAction, seq: number | null): Promise<MoveResult>;
  /** Closes any stage run still going for the project (the Worker notices on its next heartbeat and stops). */
  supersedeRunning(projectId: string, reason: string): Promise<void>;
}

export interface HistoryReply {
  status: number;
  body: Record<string, unknown>;
}

const NOT_MOVED: Record<string, string> = {
  no_history: 'There are no saved versions to go back to yet.',
  nothing_to_undo: "You're already at the oldest saved version.",
  nothing_to_redo: "You're already at the newest version.",
  not_found: 'That version is no longer saved.',
  already_here: "You're already on that version.",
};

export async function moveHistory(body: { project_id?: unknown; action?: unknown; seq?: unknown }, userId: string, deps: HistoryDeps): Promise<HistoryReply> {
  if (typeof body.project_id !== 'string' || !body.project_id || body.project_id.length > 200) return { status: 400, body: { error: 'project_id is required.', code: 'bad_project' } };
  const projectId = body.project_id;
  const action = body.action;
  if (action !== 'undo' && action !== 'redo' && action !== 'restore') return { status: 400, body: { error: 'Unknown action.', code: 'bad_action' } };
  let seq: number | null = null;
  if (action === 'restore') {
    if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 1) return { status: 400, body: { error: 'Choose a saved version.', code: 'bad_seq' } };
    seq = body.seq;
  }
  if (!(await deps.getProjectAccess(projectId, userId))) return { status: 404, body: { error: 'Project not found.', code: 'not_found' } };

  await deps.supersedeRunning(projectId, 'Superseded by a change of version');
  const moved = await deps.moveHistory(projectId, action, seq);
  if (!moved.moved) return { status: 200, body: { ok: false, moved: false, reason: moved.reason, error: NOT_MOVED[moved.reason] ?? 'Nothing was changed.' } };

  // The files are back as they were: bring the style and the launch report in step with them.
  const out: Record<string, unknown> = { ok: true, moved: true, seq: moved.seq, kind: moved.kind, label: moved.label, checked: false };
  try {
    const files = await deps.getProjectFiles(projectId);
    const latest = await deps.getLatestArtifacts(projectId);
    const inputs = inputsFrom(latest, files);
    if (typeof inputs !== 'string' && latest.manifest) {
      let site = files;
      let style = inputs.style;
      let manifestVersion = latest.manifest.version;
      const moved2 = typeof files['styles.css'] === 'string' ? styleMoved(files['styles.css'], inputs.style, { declaredOnly: true }) : null;
      if (moved2 && typeof moved2 !== 'string') {
        style = moved2;
        await deps.saveArtifact(projectId, 'style_spec', moved2 as unknown as Record<string, unknown>);
        manifestVersion = (await deps.saveArtifact(projectId, 'manifest', latest.manifest.data)).version;
        // manifest.json follows the palette — but only when its colours really differ: re-writing the same values would change the
        // file's text, and an undo must give back the saved version exactly.
        const m = files['manifest.json'];
        if (typeof m === 'string') {
          const next = manifestWithStyle(m, moved2);
          if (!sameJson(m, next)) {
            await deps.saveFiles(projectId, { 'manifest.json': next });
            site = { ...files, 'manifest.json': next };
          }
        }
      }
      const result = verifyStored({ ...inputs, style }, site);
      const saved = await saveLaunchReport(deps, projectId, result, manifestVersion);
      if (typeof saved === 'number') {
        out.checked = true;
        out.site_ok = result.ok;
        out.fails = result.problems.filter((p) => p.severity === 'fail').length;
      }
    }
  } catch (e) {
    // The versions moved; only the report is behind. "Check again" brings it up to date.
    console.error('[ai-chat] history move: could not refresh the checks', e);
  }
  return { status: 200, body: out };
}

// TWEAKS over the network (REVAMP Step 11): the site's saved versions and the move along them (undo / redo / "go back to this one").
// Pure logic lives in lib/tweaks-view.ts (unit-tested); this file is I/O.
import { AI_EDGE_URL } from '../lib/config.ts';
import { sb } from '../lib/supabase.ts';
import { readVersions, type Version } from '../lib/tweaks-view.ts';
import { authDeps } from './deps.ts';
import { postJson } from './http.ts';

/** The site's saved versions, oldest first (RLS shows the owner's own). The files themselves are not readable by clients. */
export async function listSiteHistory(projectId: string): Promise<Version[]> {
  const { data, error } = await sb.from('site_snapshots').select('seq,kind,label,is_current,created_at').eq('project_id', projectId).order('seq', { ascending: true }).limit(100);
  if (error) throw new Error(error.message);
  return readVersions(data);
}

export type HistoryAction = 'undo' | 'redo' | 'restore';

export interface MoveOutcome {
  ok: boolean;
  moved: boolean;
  /** The version the site is at now. */
  label?: string;
  /** Plain English when nothing moved. */
  error?: string;
  /** The launch check was re-run on the version that is back. */
  checked?: boolean;
  fails?: number;
}

/** Undo / redo one version, or restore a chosen one (`seq`). A refusal ("nothing to undo") is a normal answer, not a throw. */
export async function moveHistory(projectId: string, action: HistoryAction, seq?: number): Promise<MoveOutcome> {
  const out = await postJson<Partial<MoveOutcome>>(AI_EDGE_URL, { tweaks_history: { project_id: projectId, action, ...(action === 'restore' ? { seq } : {}) } }, authDeps);
  return {
    ok: out.ok === true,
    moved: out.moved === true,
    ...(typeof out.label === 'string' ? { label: out.label } : {}),
    ...(typeof out.error === 'string' ? { error: out.error } : {}),
    ...(out.checked === true ? { checked: true } : {}),
    ...(typeof out.fails === 'number' ? { fails: out.fails } : {}),
  };
}

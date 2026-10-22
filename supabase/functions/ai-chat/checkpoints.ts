// Checkpoints of the site's history (REVAMP Step 11). The database keeps the line (site_snapshots, take_site_snapshot,
// move_site_history); this is the small piece the stage code shares: take one at the end of a stage, without ever failing the stage.

export type CheckpointKind = 'stage' | 'tweak' | 'baseline';

export interface CheckpointDeps {
  /** take_site_snapshot as the platform: a checkpoint of the site as it is now (none when it equals "you are here"). */
  snapshot(projectId: string, kind: CheckpointKind, label: string): Promise<{ seq: number; created: boolean }>;
}

/** History is a safety net, not part of the job: a checkpoint that cannot be taken is logged, and the stage carries on. */
export async function takeCheckpoint(deps: CheckpointDeps, projectId: string, kind: CheckpointKind, label: string): Promise<number | null> {
  try {
    return (await deps.snapshot(projectId, kind, label)).seq;
  } catch (e) {
    console.error('[ai-chat] could not take a checkpoint', e);
    return null;
  }
}

/** What the owner asked for, as a short label for the history list ("make the title bigger" → "Make the title bigger"). */
export function requestLabel(request: string, max = 70): string {
  const t = request.replace(/\s+/g, ' ').trim();
  if (!t) return 'A change';
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return cap.length > max ? `${cap.slice(0, max - 1).trimEnd()}…` : cap;
}

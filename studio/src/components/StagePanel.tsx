import { LEGACY } from '../lib/config.ts';
import { STAGE_BLURBS, artifactCards, continueBlockers } from '../lib/stage-view.ts';
import { STAGE_LABELS, describeBlocker, nextStage, prevStage, type ArtifactKind, type LatestArtifacts, type Stage } from '../lib/stages.ts';

interface Props {
  projectId: string;
  stage: Stage;
  artifacts: LatestArtifacts;
  published: boolean;
  busy: boolean;
  onKeep: (kind: ArtifactKind) => void;
  onMove: (stage: Stage) => void;
}

/** The current stage: what it reads and works on (with stale state), the way forward, the way back. The guided screens plug in above the artifacts (Steps 8–12). */
export function StagePanel({ projectId, stage, artifacts, published, busy, onKeep, onMove }: Props) {
  const cards = artifactCards(stage, artifacts);
  const next = nextStage(stage);
  const prev = prevStage(stage);
  const blocked = continueBlockers(stage, artifacts, published);
  return (
    <section class="card panel" aria-labelledby="stage-title" data-testid="stage-panel" data-stage={stage}>
      <h2 id="stage-title">{STAGE_LABELS[stage]}</h2>
      <p class="sub">{STAGE_BLURBS[stage]}</p>

      {cards.length > 0 && (
        <ul class="artifacts" aria-label="What this step uses">
          {cards.map((c) => (
            <li key={c.kind} class={'artifact' + (c.stale ? ' stale' : '')} data-kind={c.kind}>
              <div class="artifact-head">
                <span class="artifact-name">{c.label}</span>
                <span class="artifact-role">{c.role === 'input' ? 'from an earlier step' : 'this step works on'}</span>
                {c.version === null ? <span class="pill">Not made yet</span> : c.stale ? <span class="pill warn">Out of date</span> : <span class="pill ok">Up to date · v{c.version}</span>}
                {c.keepable && (
                  <button type="button" class="btn small ghost" disabled={busy} onClick={() => onKeep(c.kind)}>
                    Keep as is
                  </button>
                )}
              </div>
              {c.version !== null && (
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(artifacts[c.kind]?.data ?? {}, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <p class="sub soon">
        The guided {STAGE_LABELS[stage].toLowerCase()} screen is on its way. Until then, keep building in the{' '}
        <a class="link" href={LEGACY.editor(projectId)}>editor</a> — everything you make there carries over.
      </p>

      <div class="panel-actions">
        {prev ? (
          <button type="button" class="btn ghost" disabled={busy} data-testid="stage-back" onClick={() => onMove(prev)}>
            Back to {STAGE_LABELS[prev]}
          </button>
        ) : <span />}
        {next && (
          <div class="continue">
            <button type="button" class="btn" disabled={busy || blocked.length > 0} data-testid="stage-continue" onClick={() => onMove(next)}>
              Continue to {STAGE_LABELS[next]}
            </button>
            {blocked.length > 0 && <span class="why" data-testid="stage-why">{blocked.map(describeBlocker).join('. ')}.</span>}
          </div>
        )}
      </div>
    </section>
  );
}

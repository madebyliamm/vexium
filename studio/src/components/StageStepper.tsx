import { describeBlocker } from '../lib/stages.ts';
import type { Step } from '../lib/stage-view.ts';

/** The six-stage stepper. Blocked stages stay clickable (aria-disabled) so the click can explain what is missing. */
export function StageStepper({ steps, busy, onPick }: { steps: Step[]; busy: boolean; onPick: (step: Step) => void }) {
  return (
    <ol class="stages" aria-label="Stages">
      {steps.map((s) => {
        const why = s.state === 'blocked' ? s.blockedBy.map(describeBlocker).join('. ') : s.attention ? 'Out of date — an earlier step changed' : '';
        return (
          <li key={s.stage}>
            <button
              type="button"
              class={`stage ${s.state}${s.attention ? ' attention' : ''}`}
              data-stage={s.stage}
              data-state={s.state}
              aria-current={s.state === 'current' ? 'step' : undefined}
              aria-disabled={s.state === 'blocked' || busy ? 'true' : undefined}
              title={why || undefined}
              onClick={() => onPick(s)}
            >
              <span class="n">{s.n}</span>
              {s.label}
              {s.attention && <span class="attn" role="img" aria-label="out of date" />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

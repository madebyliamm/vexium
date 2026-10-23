import { useEffect, useRef, useState } from 'preact/hooks';
import { askPartner } from '../api/advice.ts';
import {
  WAIT_TEXT, applyText, askProblem, basisNote, loadAdvice, partnerReady, saveAdvice, type KV, type PartnerAdvice, type PartnerReply, type Rec,
} from '../lib/advice-view.ts';
import type { BusinessState } from '../types/artifacts.ts';

interface Props {
  projectId: string;
  /** The numbers on the screen. The partner reads the server's saved copy of these, never anything from here. */
  state: BusinessState;
  /** The project is busy (a stage change or a run): hold the buttons that would start something. */
  busy: boolean;
  /** Re-read the numbers from the server (so the saved copy is fresh) — resolves when they are on screen. */
  refreshNumbers: () => Promise<void>;
  /** Apply: hand this plain-language change to the TWEAKS screen. */
  onApply: (instruction: string) => void;
}

const STALE_TEXT = 'Couldn’t get fresh numbers to look at. Press Refresh above, then ask again.';

/** This tab's own storage, or nothing when the browser blocks it. */
function tabStorage(): KV | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/**
 * "Your business partner": plain-language next steps that each point at the owner's own numbers. It only runs when the owner asks
 * (it uses AI credits), says so honestly when there is too little data, and Apply sends a suggested site change to TWEAKS as one click.
 */
export function PartnerPanel({ projectId, state, busy, refreshNumbers, onApply }: Props) {
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const [kept] = useState(() => { const kv = tabStorage(); return kv ? loadAdvice(kv, projectId) : null; });
  const [advice, setAdvice] = useState<PartnerAdvice | null>(kept?.advice ?? null);
  const [applied, setApplied] = useState<string[]>(kept?.applied ?? []);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [wait, setWait] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);

  const remember = (a: PartnerAdvice, done: string[]) => {
    const kv = tabStorage();
    if (kv) saveAdvice(kv, projectId, { advice: a, applied: done });
  };

  const ask = async () => {
    if (asking) return;
    setAsking(true);
    setProblem(null);
    setWait(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      let reply: PartnerReply;
      try {
        reply = await askPartner(projectId, ctl.signal);
      } catch (e) {
        if (!askProblem(e).refresh) throw e;
        // The saved numbers were too old (a tab left open): bring them up to date, then ask once more.
        await refreshNumbers();
        if (!alive.current) return;
        try {
          reply = await askPartner(projectId, ctl.signal);
        } catch (e2) {
          if (askProblem(e2).refresh) { setProblem(STALE_TEXT); return; }
          throw e2;
        }
      }
      if (!alive.current) return;
      if (reply.status === 'not_enough_data') {
        setWait(reply.message);
      } else {
        setAdvice(reply.advice);
        setApplied([]);
        remember(reply.advice, []);
      }
    } catch (e) {
      if (alive.current && !ctl.signal.aborted) setProblem(askProblem(e).text);
    } finally {
      if (alive.current) setAsking(false);
    }
  };

  const apply = (r: Rec) => {
    const instruction = applyText(r);
    if (!instruction || !advice || busy) return;
    const done = applied.includes(r.id) ? applied : [...applied, r.id];
    setApplied(done);
    remember(advice, done);
    onApply(instruction);
  };

  const ready = partnerReady(state);
  const level = state.data_level === 'early' ? 'early' : 'none';

  return (
    <section class="card partner" aria-label="Your business partner" data-testid="biz-partner" data-state={!ready ? 'waiting' : asking ? 'asking' : advice ? 'advice' : 'idle'}>
      <div class="partner-head">
        <h3>Your business partner</h3>
        {ready && advice && !asking && (
          <button type="button" class="btn small ghost" disabled={busy} data-testid="partner-ask-again" onClick={() => void ask()}>Ask again</button>
        )}
      </div>

      {!ready ? (
        <p class="sub" data-testid="partner-wait">{WAIT_TEXT[level]}</p>
      ) : (
        <>
          {!advice && !asking && (
            <>
              <p class="sub">Get a few ideas for what to do next, based only on the numbers on this page. It uses a little of your AI credits each time you ask.</p>
              <div><button type="button" class="btn" disabled={busy} data-testid="partner-ask" onClick={() => void ask()}>Ask my partner</button></div>
            </>
          )}
          {asking && <div class="notice" role="status" data-testid="partner-asking"><span class="spinner inline" aria-hidden="true" /> Looking at your numbers…</div>}
          {problem && <div class="error" role="alert" data-testid="partner-error">{problem}</div>}
          {wait && !asking && <p class="sub" role="status" data-testid="partner-wait">{wait}</p>}

          {advice && (
            <div class={'partner-body' + (asking ? ' is-loading' : '')} data-testid="partner-advice">
              {advice.headline && <p class="partner-headline" data-testid="partner-headline">{advice.headline}</p>}
              {advice.recommendations.length === 0 ? (
                <p class="sub" data-testid="partner-none">Nothing stands out to change right now. Check back as more people visit.</p>
              ) : (
                <ol class="recs">
                  {advice.recommendations.map((r) => {
                    const can = applyText(r) !== null;
                    const done = applied.includes(r.id);
                    return (
                      <li key={r.id} class="rec" data-testid="partner-rec" data-id={r.id} data-applied={done}>
                        <h4>{r.title}</h4>
                        <p class="rec-why">{r.why}</p>
                        <ul class="rec-evidence" aria-label="The numbers behind this">
                          {r.evidence.map((e) => <li key={e.id} data-testid="partner-evidence" data-id={e.id}>{e.text}</li>)}
                        </ul>
                        {can && (
                          <div class="rec-actions">
                            <button type="button" class={'btn small' + (done ? ' ghost' : '')} disabled={busy || asking} data-testid="partner-apply" onClick={() => apply(r)}>
                              {done ? 'Apply again' : 'Apply'}
                            </button>
                            {done && <span class="sub small ok-text" data-testid="partner-applied">Sent to Edit site — check it there, then update your live site.</span>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              <p class="sub small partner-basis" data-testid="partner-basis">
                {basisNote(advice, state)} Apply changes your draft only — visitors see it after you update your live site.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

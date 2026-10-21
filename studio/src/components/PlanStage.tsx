import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { applyBuildEvent, emptyBuildResult, streamStage } from '../api/ai.ts';
import { renameProject } from '../api/data.ts';
import { authDeps } from '../api/deps.ts';
import { ApiError } from '../api/http.ts';
import { cancelStageRun, listStageMessages, saveArtifact } from '../api/stages.ts';
import { takePendingMessage } from '../lib/pending.ts';
import { historyToSend, planHints, planProblems, readPlan, samePlan, syncedName, type ChatLine } from '../lib/plan-view.ts';
import { emptyPlan, type Plan } from '../types/artifacts.ts';
import { PlanCard } from './PlanCard.tsx';
import { PlanChat } from './PlanChat.tsx';

interface Props {
  projectId: string;
  projectName: string;
  /** The saved plan (newest version), or null when none exists yet. */
  saved: { version: number; data: Record<string, unknown> } | null;
  /** A run that started before this page loaded (or in another tab) is still going: its build_jobs id. */
  resumedJobId: string | null;
  /** Something changed on the server (a plan was saved, a run ended, the project was renamed): re-read the project. */
  onChanged: () => void;
  /** Whether the card holds edits that are not saved yet (the parent keeps "Continue" closed until they are). */
  onDirtyChange: (dirty: boolean) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The guided PLAN screen: talk on the left, an editable plan card on the right. The AI proposes, the owner edits, both save new plan versions. */
export function PlanStage({ projectId, projectName, saved, resumedJobId, onChanged, onDirtyChange }: Props) {
  const savedVersion = saved?.version ?? 0;
  const savedPlan = useMemo(() => (saved ? readPlan(saved.data, projectName || 'Untitled') : null), [saved?.version]);

  // ── the card ──
  const [draft, setDraft] = useState<Plan | null>(savedPlan);
  const [baseline, setBaseline] = useState<Plan | null>(savedPlan);
  const [baseVersion, setBaseVersion] = useState(savedVersion);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = draft !== null && (baseline === null || !samePlan(draft, baseline));
  /** A newer version was saved elsewhere while this card holds unsaved edits. */
  const conflict = dirty && savedVersion > baseVersion;

  // ── the chat ──
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState<{ text: string } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const running = live !== null || resumedJobId !== null;

  const reloadChat = useCallback(async (): Promise<ChatLine[] | null> => {
    try {
      const l = await listStageMessages(projectId, 'plan');
      if (alive.current) setLines(l);
      return l;
    } catch {
      return null; // keep what is on screen; the history is a convenience
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);
  // On arrival, and whenever a run elsewhere starts or ends.
  useEffect(() => {
    void reloadChat();
  }, [reloadChat, resumedJobId]);

  // A newer saved version replaces the card — unless there are unsaved edits (then the owner decides, see `conflict`).
  useEffect(() => {
    if (savedVersion === baseVersion || dirty) return;
    setDraft(savedPlan);
    setBaseline(savedPlan);
    setBaseVersion(savedVersion);
  }, [savedVersion]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The project is still "Untitled" and the plan got a real name: give the project that name too (once).
  const renamedTo = useRef<string | null>(null);
  useEffect(() => {
    if (!savedPlan) return;
    const next = syncedName(projectName, savedPlan.name);
    if (!next || renamedTo.current === next) return;
    renamedTo.current = next;
    renameProject(projectId, next).then(onChanged, () => {});
  }, [savedPlan?.name, projectName]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return true;
    const problems = planProblems(draft);
    if (problems.length > 0) {
      setSaveError(problems.join('. ') + '.');
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const out = await saveArtifact(projectId, 'plan', draft as unknown as Record<string, unknown>, baseVersion);
      if (!alive.current) return true;
      setBaseline(draft);
      setBaseVersion(out.version);
      onChanged();
      return true;
    } catch (e) {
      if (alive.current) setSaveError(message(e));
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [draft, projectId, baseVersion, onChanged]);

  const discard = () => {
    setDraft(savedPlan);
    setBaseline(savedPlan);
    setBaseVersion(savedVersion);
    setSaveError(null);
  };

  /** Send `userText` (or, with null, answer the owner's last unanswered line again) and show the reply as it arrives. */
  const send = useCallback(
    async (userText: string | null) => {
      if (running) return;
      setRunError(null);
      if (dirty && !(await save())) {
        if (alive.current) setRunError("Your plan has changes that can't be saved yet — see the plan card. Your message is still here.");
        return;
      }
      const next: ChatLine[] = userText === null ? lines : [...lines, { id: 'local-' + Date.now(), role: 'user', content: userText }];
      const messages = historyToSend(next);
      if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') return;
      setLines(next);
      setText('');
      setLive({ text: '' });
      const ctl = new AbortController();
      abort.current = ctl;
      const result = emptyBuildResult();
      let failure: string | null = null;
      try {
        for await (const ev of streamStage({ stage: 'plan', project_id: projectId, messages, stream: true }, authDeps, { signal: ctl.signal })) {
          applyBuildEvent(result, ev);
          if (ev.type === 'stage_job') setJobId(ev.job_id);
          if (ev.type === 'delta' && alive.current) setLive({ text: result.chat });
        }
        if (result.stageDone && !result.stageDone.ok) failure = result.stageDone.error || 'The plan could not be updated.';
        else if (!result.stageDone) failure = result.error || 'The connection was interrupted. If the plan was still being updated it will appear here when it is done.';
      } catch (e) {
        if (!ctl.signal.aborted) failure = e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.';
      }
      if (!alive.current) return;
      // The server is the truth about what was kept: its history replaces the one on screen.
      const kept = await reloadChat();
      if (!alive.current) return;
      setLive(null);
      setJobId(null);
      abort.current = null;
      setRunError(failure);
      // A message the server never took (refused before the run began) goes back into the box instead of vanishing.
      if (userText !== null && kept && !kept.slice(-2).some((l) => l.role === 'user' && l.content === userText)) setText((cur) => cur || userText);
      onChanged();
    },
    [running, dirty, save, lines, projectId, reloadChat, onChanged],
  );

  const stop = async () => {
    const id = jobId ?? resumedJobId;
    if (id) await cancelStageRun(id).catch(() => {});
    abort.current?.abort();
  };

  // The first message of a brand-new project ("Draft my plan" on the home screen) goes out as soon as the chat is ready.
  useEffect(() => {
    if (!loaded) return;
    const first = takePendingMessage(projectId);
    if (first) void send(first);
  }, [loaded]);

  const startBlank = () => {
    const plan = emptyPlan(projectName && projectName !== 'Untitled' ? projectName : 'Untitled');
    setDraft(plan);
    setBaseline(null);
    setBaseVersion(0);
  };

  const hints = savedPlan && !dirty ? planHints(savedPlan) : [];

  return (
    <div class="plan-grid" data-testid="plan-stage">
      <PlanChat
        lines={lines}
        loaded={loaded}
        live={live}
        resumed={resumedJobId !== null}
        error={runError}
        text={text}
        onText={setText}
        onSend={() => void send(text.trim())}
        onRetry={() => void send(null)}
        onStop={() => void stop()}
      />
      <section class="card plan-card" aria-label="Your plan" data-testid="plan-card">
        <div class="plan-head">
          <h2>Your plan</h2>
          <span class={'pill' + (dirty ? ' warn' : draft ? ' ok' : '')} data-testid="plan-status">
            {running ? 'Updating…' : dirty ? 'Unsaved changes' : draft ? `Saved · v${baseVersion}` : 'Not started'}
          </span>
        </div>
        {draft ? (
          <>
            <PlanCard plan={draft} locked={running || saving} onEdit={(p) => { setDraft(p); setSaveError(null); }} />
            {conflict && (
              <div class="notice" role="alert" data-testid="plan-conflict">
                The plan was changed somewhere else. Saving now would overwrite that.
                <button type="button" class="btn small ghost" onClick={discard}>Use the latest version</button>
              </div>
            )}
            {saveError && <div class="error" role="alert" data-testid="plan-save-error">{saveError}</div>}
            <div class="plan-actions">
              {dirty && <button type="button" class="btn ghost" disabled={saving || running} data-testid="plan-discard" onClick={discard}>Discard changes</button>}
              <button type="button" class="btn" disabled={!dirty || saving || running || conflict} data-testid="plan-save" onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save plan'}
              </button>
            </div>
            {hints.length > 0 && <p class="sub" data-testid="plan-hints">Still worth a look before you go on: {hints.join('; ')}.</p>}
          </>
        ) : (
          <div class="plan-empty" data-testid="plan-empty">
            <p class="sub">Your plan appears here as soon as you tell me about your idea — then you can change any part of it.</p>
            <button type="button" class="btn small ghost" disabled={running} data-testid="plan-blank" onClick={startBlank}>Fill it in myself</button>
          </div>
        )}
      </section>
    </div>
  );
}

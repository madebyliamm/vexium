import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { applyBuildEvent, emptyBuildResult, streamStage } from '../api/ai.ts';
import { authDeps } from '../api/deps.ts';
import { getExampleFiles, setProjectFiles } from '../api/example.ts';
import { ApiError } from '../api/http.ts';
import { cancelStageRun, listStageMessages, saveArtifact } from '../api/stages.ts';
import {
  STATUS_LABELS, controlsClosedReason, draftCss, exampleStatus, hasExample, isDirty, lastAssistantLine, livePreviewFiles, pickFiles, planSave,
  previewProblem, progressSteps, readStyleSpec, readabilityHints, runMessage, specToSave, type ExampleFiles,
} from '../lib/example-view.ts';
import { splitLiveReply } from '../lib/plan-view.ts';
import { withVibe, type VibeChange } from '../lib/style.ts';
import type { StyleSpec } from '../types/artifacts.ts';
import { Preview } from './Preview.tsx';
import { VibeControls } from './VibeControls.tsx';

interface Props {
  projectId: string;
  /** The saved style (newest version), or null when none exists yet. */
  saved: { version: number; data: Record<string, unknown> } | null;
  /** A run that started before this page loaded (or in another tab) is still going: its build_jobs id. */
  resumedJobId: string | null;
  /** Something changed on the server (a style was saved, a run ended): re-read the project. */
  onChanged: () => void;
  /** Whether the controls hold changes that are not saved yet (the parent keeps "Continue" closed until they are). */
  onDirtyChange: (dirty: boolean) => void;
}

/** What the draft started from: the saved style (and its version) plus the page files it was read with. */
interface Base {
  version: number;
  spec: StyleSpec;
  files: ExampleFiles;
}

interface Live {
  chat: string;
  files: Record<string, string>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The guided EXAMPLE screen: the landing page, the five vibe controls that re-skin it by swapping tokens (no AI), and "Lock this
 * style". The AI runs only to build the page (first time) or to make a new version of it.
 */
export function ExampleStage({ projectId, saved, resumedJobId, onChanged, onDirtyChange }: Props) {
  const savedVersion = saved?.version ?? 0;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  // ── what is saved, and the draft on top of it ──
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<StyleSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editSeq = useRef(0);

  // ── the run ──
  const [live, setLive] = useState<Live | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [otherPage, setOtherPage] = useState<string | null>(null);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const running = live !== null || resumedJobId !== null;

  const built = base !== null && hasExample(base.spec, base.files);
  const dirty = base !== null && draft !== null && built && isDirty(base.spec, base.files, draft);
  const locked = base?.spec.locked === true;
  /** A newer version was saved elsewhere while the controls hold unsaved changes. */
  const conflict = dirty && base !== null && savedVersion > base.version;

  /** Read the saved files + style from the server and make them the new starting point (the draft restarts from it). */
  const adopt = useCallback(async () => {
    const seq = editSeq.current;
    try {
      const files = (await getExampleFiles(projectId)) ?? pickFiles(null);
      if (!alive.current || editSeq.current !== seq) return; // the owner started editing while this was loading: theirs wins
      const s = savedRef.current;
      const spec = s ? readStyleSpec(s.data) : null;
      if (s && spec) {
        setBase({ version: s.version, spec, files });
        setDraft(spec);
      } else {
        setBase(null);
        setDraft(null);
      }
      setLoadError(null);
      setSaveError(null);
    } catch (e) {
      if (alive.current) setLoadError(message(e));
    } finally {
      if (alive.current) setReady(true);
    }
  }, [projectId]);

  const reloadSaid = useCallback(async () => {
    try {
      const lines = await listStageMessages(projectId, 'example');
      if (alive.current) setSaid(lastAssistantLine(lines));
    } catch {
      /* the note is a convenience */
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void adopt();
    void reloadSaid();
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  // A new version was saved elsewhere, or a run (here or in another tab) ended: follow it — unless there are unsaved changes.
  useEffect(() => {
    if (!ready || live || resumedJobId || dirty) return;
    void adopt();
    void reloadSaid();
  }, [savedVersion, resumedJobId]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);
  useEffect(() => {
    if (!dirty && !live) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, !!live]);

  // ── the vibe controls: a pure token swap, applied to the draft ──
  const change = (c: VibeChange) => {
    if (!draft || running || locked) return;
    editSeq.current++;
    setDraft(withVibe(draft, c));
    setSaveError(null);
  };

  const discard = () => {
    if (!base) return;
    editSeq.current++;
    setDraft(base.spec);
    setSaveError(null);
  };

  /** Save the look (artifact first — it carries the version guard — then the files) and, with `lock`, its lock state, as ONE version. */
  const save = useCallback(
    async (lock: boolean | null = null): Promise<boolean> => {
      if (!base || !draft) return true;
      const wantLocked = lock ?? base.spec.locked;
      const plan = planSave(base.spec, base.files, draft);
      const lockChanged = wantLocked !== base.spec.locked;
      if (plan.nothing && !lockChanged) return true;
      setSaving(true);
      setSaveError(null);
      let next: Base = base;
      try {
        if (plan.artifact || lockChanged) {
          const target = specToSave(draft, wantLocked);
          const out = await saveArtifact(projectId, 'style_spec', target as unknown as Record<string, unknown>, base.version);
          next = { ...next, version: out.version, spec: target };
          if (alive.current) setBase(next); // the style is in; if the files below fail, Save will finish the job
        }
        if (Object.keys(plan.files).length > 0) {
          await setProjectFiles(projectId, plan.files);
          next = { ...next, files: { ...next.files, css: plan.files['styles.css'] ?? next.files.css, manifest: plan.files['manifest.json'] ?? next.files.manifest } };
          if (alive.current) setBase(next);
        }
        if (alive.current) setDraft(next.spec);
        onChanged();
        return true;
      } catch (e) {
        if (alive.current) setSaveError(message(e));
        return false;
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [base, draft, projectId, onChanged],
  );

  /** Build the page (first time) or make a new version of it. Saves unsaved look changes first: the AI is shown the saved style. */
  const run = useCallback(
    async (text: string) => {
      if (running || saving) return;
      setRunError(null);
      setProblem(null);
      setOtherPage(null);
      if (dirty && !(await save())) {
        if (alive.current) setRunError("Your style changes couldn't be saved yet — see the message beside the controls.");
        return;
      }
      const messages = [{ role: 'user' as const, content: runMessage(text, !built) }];
      setLive({ chat: '', files: {} });
      const ctl = new AbortController();
      abort.current = ctl;
      const result = emptyBuildResult();
      let failure: string | null = null;
      try {
        for await (const ev of streamStage({ stage: 'example', project_id: projectId, messages, stream: true }, authDeps, { signal: ctl.signal })) {
          applyBuildEvent(result, ev);
          if (ev.type === 'stage_job') setJobId(ev.job_id);
          if (!alive.current) continue;
          if (ev.type === 'delta') setLive((l) => (l ? { ...l, chat: result.chat } : l));
          if (ev.type === 'file') setLive((l) => (l ? { ...l, files: { ...result.files } } : l));
        }
        if (result.stageDone && !result.stageDone.ok) failure = result.stageDone.error || 'The page could not be built.';
        else if (!result.stageDone) failure = result.error || 'The connection was interrupted. If your page was still being built it will appear here when it is done.';
      } catch (e) {
        if (!ctl.signal.aborted) failure = e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.';
      }
      if (!alive.current) return;
      setLive(null);
      setJobId(null);
      abort.current = null;
      setRunError(failure);
      if (!failure) setNote('');
      onChanged();
    },
    [running, saving, dirty, save, built, projectId, onChanged],
  );

  const stop = async () => {
    const id = jobId ?? resumedJobId;
    if (id) await cancelStageRun(id).catch(() => {});
    abort.current?.abort();
  };

  // ── what is on screen ──
  const streamed = live ? livePreviewFiles(live.files) : null;
  const shown: ExampleFiles | null = streamed ?? (built && base ? base.files : null);
  const shownCss = streamed ? streamed.css : built && base && draft ? draftCss(base.files.css, draft) : '';
  const status = exampleStatus({ running, built, dirty, locked });
  const closedReason = controlsClosedReason({ running, locked, saving });
  const hints = draft && !running ? readabilityHints(draft) : [];
  const liveReply = live ? splitLiveReply(live.chat) : null;

  // An error the page reported belongs to that version of the page.
  useEffect(() => setProblem(null), [shown?.html, shown?.js]);

  if (!ready) return <div class="sk example-sk" aria-hidden="true" data-testid="example-loading" />;
  if (loadError && !base) {
    return <div class="error" role="alert" data-testid="example-load-error">Couldn't load your page: {loadError} <button type="button" class="btn small ghost" onClick={() => void adopt()}>Try again</button></div>;
  }

  return (
    <div class="example-grid" data-testid="example-stage" data-status={status}>
      <section class="card example-main" aria-label="Your landing page">
        <div class="plan-head">
          <h2>Your landing page</h2>
          <span class={'pill' + (status === 'unsaved' ? ' warn' : status === 'locked' ? ' ok' : '')} data-testid="example-status">{STATUS_LABELS[status]}</span>
        </div>

        {running && (
          <div class="example-running" data-testid="example-running" role="status">
            {live ? (
              <ol class="progress" data-testid="example-progress">
                {progressSteps(live.files).map((s) => (
                  <li key={s.file} class={'prog ' + s.state} data-state={s.state}>
                    {s.state === 'done' ? <span class="tick" aria-hidden="true">✓</span> : s.state === 'active' ? <span class="spinner inline" aria-hidden="true" /> : <span class="tick todo" aria-hidden="true">○</span>}
                    {s.label}
                  </li>
                ))}
              </ol>
            ) : (
              <p class="sub"><span class="spinner inline" aria-hidden="true" />Your page is still being built — you can leave, it will be here when you come back.</p>
            )}
            {liveReply?.chat && <p class="example-note" data-testid="example-live-chat">{liveReply.chat}</p>}
            <p class="sub small">Keep this page open until it's done.</p>
            <button type="button" class="btn small ghost" data-testid="example-stop" onClick={() => void stop()}>Stop</button>
          </div>
        )}

        {shown ? (
          <div class={running ? 'preview-wrap busy' : 'preview-wrap'}>
            <Preview
              projectId={projectId}
              files={shown}
              css={shownCss}
              onProblem={(m) => setProblem(previewProblem(m))}
              onOtherPage={setOtherPage}
              key={streamed ? 'live' : 'saved'}
            />
          </div>
        ) : running ? (
          <div class="example-empty" data-testid="example-building">
            <span class="spinner" aria-hidden="true" />
            <p class="sub">{live ? 'Building your landing page…' : 'Still building your landing page…'}</p>
          </div>
        ) : (
          <div class="example-empty" data-testid="example-empty">
            <p class="sub">I'll build a one-page version of your site from your plan, so you can see how it looks and choose the style before the full build.</p>
            <textarea
              rows={2}
              value={note}
              maxLength={2000}
              placeholder="Anything it should aim for? (optional) e.g. calm, lots of white space"
              aria-label="Direction for the page (optional)"
              data-testid="example-note-input"
              onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)}
            />
            <button type="button" class="btn" disabled={saving} data-testid="example-build" onClick={() => void run(note)}>Build my landing page</button>
            <p class="sub small">Takes about a minute. Keep this page open while it builds.</p>
          </div>
        )}

        {!running && runError && <div class="error" role="alert" data-testid="example-run-error">{runError}</div>}
        {problem && !running && <div class="notice" role="status" data-testid="preview-problem">{problem}</div>}
        {otherPage && (
          <div class="notice" role="status" data-testid="preview-other-page">
            “{otherPage}” belongs to the full site — it's built in the next step, in this style.
            <button type="button" class="btn small ghost" onClick={() => setOtherPage(null)}>OK</button>
          </div>
        )}
        {!running && said && built && <p class="example-note" data-testid="example-said">{said}</p>}
      </section>

      <aside class="card example-side" aria-label="Make it yours">
        <h2>Make it yours</h2>
        {draft && built ? (
          <>
            <p class="sub">Every choice changes the page instantly — nothing is rebuilt.</p>
            {closedReason && <p class="sub small" data-testid="vibe-closed">{closedReason}</p>}
            <VibeControls spec={draft} disabled={running || locked || saving} onChange={change} />
            {hints.length > 0 && <p class="sub small hint" data-testid="vibe-hints">{hints.join(' ')}</p>}
            {conflict && (
              <div class="notice" role="alert" data-testid="style-conflict">
                Your style was changed somewhere else. Saving now would overwrite that.
                <button type="button" class="btn small ghost" onClick={() => void adopt()}>Use the latest version</button>
              </div>
            )}
            {saveError && <div class="error" role="alert" data-testid="style-save-error">{saveError}</div>}
            {dirty && (
              <div class="plan-actions">
                <button type="button" class="btn ghost" disabled={saving} data-testid="style-discard" onClick={discard}>Discard</button>
                <button type="button" class="btn" disabled={saving || conflict} data-testid="style-save" onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button>
              </div>
            )}

            <div class="lock-box" data-testid="lock-box" data-locked={locked}>
              {locked ? (
                <>
                  <p><b>🔒 Style locked.</b> Your full site will be built in exactly this look.</p>
                  <button type="button" class="btn ghost" disabled={saving || running} data-testid="style-unlock" onClick={() => void save(false)}>Unlock to change it</button>
                </>
              ) : (
                <>
                  <p><b>Happy with the look?</b> Lock it, and your full site is built in exactly this style.</p>
                  <button type="button" class="btn" disabled={saving || running || conflict} data-testid="style-lock" onClick={() => void save(true)}>
                    {saving ? 'Saving…' : dirty ? 'Save and lock this style' : 'Lock this style'}
                  </button>
                </>
              )}
            </div>

            <details class="redo" data-testid="redo-box">
              <summary>Want a different page?</summary>
              <p class="sub small">The AI builds a new version of the page and keeps your colour, fonts, spacing and tone unless you ask it to change them.</p>
              <textarea
                rows={2}
                value={note}
                maxLength={2000}
                disabled={running || locked}
                placeholder="e.g. bolder, more like a magazine, less text"
                aria-label="What should be different (optional)"
                data-testid="redo-note"
                onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)}
              />
              <button type="button" class="btn ghost" disabled={running || locked || saving} data-testid="example-redo" onClick={() => void run(note)}>
                {locked ? 'Unlock first to build a new version' : 'Build a new version'}
              </button>
            </details>
          </>
        ) : (
          <p class="sub" data-testid="vibe-waiting">The controls appear as soon as your page is built.</p>
        )}
      </aside>
    </div>
  );
}

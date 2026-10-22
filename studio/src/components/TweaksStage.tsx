import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { applyBuildEvent, emptyBuildResult, streamStage } from '../api/ai.ts';
import { getSiteFiles, recheckSite } from '../api/build.ts';
import { authDeps } from '../api/deps.ts';
import { ApiError } from '../api/http.ts';
import { cancelStageRun, listStageMessages } from '../api/stages.ts';
import { listSiteHistory, moveHistory, type HistoryAction } from '../api/tweaks.ts';
import { readManifest, readReport, reportView } from '../lib/build-view.ts';
import type { ChatLine } from '../lib/plan-view.ts';
import type { PickedElement } from '../lib/preview.ts';
import type { ArtifactKind, LatestArtifacts } from '../lib/stages.ts';
import {
  KIND_LABELS, changeSummary, draftNote, historyState, moveNotice, newestFirst, sameFiles, tweakHistory, tweakOutcome, tweaksBlocker, versionLine, type Version,
} from '../lib/tweaks-view.ts';
import { SitePreview } from './SitePreview.tsx';
import { TweaksChat } from './TweaksChat.tsx';

interface Props {
  projectId: string;
  artifacts: LatestArtifacts;
  /** A live Hosting v2 deploy exists (the draft note says the live site stays as it is). */
  published: boolean;
  /** A run that started before this page loaded (or in another tab) is still going: its build_jobs id. */
  resumedJobId: string | null;
  busy: boolean;
  /** "Still fine, keep it" on a stale plan / style / site. */
  onKeep: (kind: ArtifactKind) => void;
  /** Something changed on the server (a change was saved, a run ended, the launch report was refreshed): re-read the project. */
  onChanged: () => void;
  /** A change is being made right now (the parent keeps "Continue" closed meanwhile). */
  onRunningChange: (running: boolean) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The guided TWEAKS screen: the finished site on one side (point at anything, switch pages and device sizes), the conversation on the
 * other. Every change lands in the draft and as a saved version, so undo, redo and "go back to this one" are always there.
 */
export function TweaksStage({ projectId, artifacts, published, resumedJobId, busy, onKeep, onChanged, onRunningChange }: Props) {
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);

  const manifestRow = artifacts.manifest ?? null;
  const manifest = manifestRow ? readManifest(manifestRow.data) : null;
  const pages = manifest?.pages ?? [];
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const manifestVersion = manifestRow?.version ?? 0;
  const reportRow = artifacts.launch_checks ?? null;
  const report = reportRow ? readReport(reportRow.data) : null;
  const view = report ? reportView(report) : null;
  const planStale = artifacts.plan?.stale === true;
  const styleStale = artifacts.style_spec?.stale === true;
  const blocker = tweaksBlocker({ hasSite: manifest !== null, planStale, styleStale });
  const reportOutdated = !!report && manifestRow !== null && report.manifest_version !== manifestRow.version;

  // ── the site ──
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [pickOn, setPickOn] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);

  // ── versions ──
  const [versions, setVersions] = useState<Version[]>([]);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // ── the chat ──
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState<{ text: string; making: boolean } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const running = live !== null || resumedJobId !== null;

  const loadFiles = useCallback(async () => {
    const ps = pagesRef.current;
    if (ps.length === 0) return;
    try {
      const f = await getSiteFiles(projectId, ps);
      if (!alive.current) return;
      // The same text must not reload the preview (and lose the page the owner is looking at).
      setFiles((cur) => (cur && sameFiles(cur, f) ? cur : f));
      setFilesError(null);
    } catch (e) {
      if (alive.current) setFilesError(message(e));
    }
  }, [projectId]);

  const loadVersions = useCallback(async () => {
    try {
      const v = await listSiteHistory(projectId);
      if (alive.current) setVersions(v);
    } catch {
      // keep what is on screen; undo reports its own problems
    }
  }, [projectId]);

  const reloadChat = useCallback(async (): Promise<ChatLine[] | null> => {
    try {
      const l = await listStageMessages(projectId, 'tweaks');
      if (alive.current) setLines(l);
      return l;
    } catch {
      return null;
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
  useEffect(() => {
    void loadFiles();
  }, [manifestVersion, loadFiles]);
  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  // A run elsewhere starts or ends: the chat moves on, and when it ends the site and the versions have changed.
  const prevJob = useRef(resumedJobId);
  useEffect(() => {
    void reloadChat();
    if (prevJob.current && !resumedJobId) {
      void loadFiles();
      void loadVersions();
    }
    prevJob.current = resumedJobId;
  }, [resumedJobId, reloadChat, loadFiles, loadVersions]);

  useEffect(() => {
    onRunningChange(running || moving);
  }, [running, moving]);
  useEffect(() => () => onRunningChange(false), []);

  const onPick = useCallback((e: PickedElement) => {
    setPicked(e);
    setPickOn(false);
  }, []);
  const onPage = useCallback((page: string) => setPicked((cur) => (cur && cur.page !== page ? null : cur)), []);

  /** Send `userText` (or, with null, answer the owner's last unanswered line again) with whatever is pointed at. */
  const send = useCallback(
    async (userText: string | null) => {
      if (running || moving) return;
      setRunError(null);
      setNotice(null);
      const next: ChatLine[] = userText === null ? lines : [...lines, { id: 'local-' + Date.now(), role: 'user', content: userText }];
      const messages = tweakHistory(next);
      if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') return;
      setLines(next);
      setText('');
      setPickOn(false);
      setLive({ text: '', making: false });
      const ctl = new AbortController();
      abort.current = ctl;
      const result = emptyBuildResult();
      let streamError: string | null = null;
      let making = false;
      try {
        const request = { stage: 'tweaks' as const, project_id: projectId, messages, ...(picked ? { pointed: picked } : {}), stream: true as const };
        for await (const ev of streamStage(request, authDeps, { signal: ctl.signal })) {
          applyBuildEvent(result, ev);
          if (ev.type === 'stage_job') setJobId(ev.job_id);
          if (ev.type === 'file_start') making = true;
          if ((ev.type === 'delta' || ev.type === 'file_start') && alive.current) setLive({ text: result.chat, making });
        }
        streamError = result.error;
      } catch (e) {
        if (!ctl.signal.aborted) streamError = e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.';
      }
      if (!alive.current) return;
      const outcome = tweakOutcome(result.stageDone, streamError);
      // The server is the truth about what was kept: its history replaces the one on screen.
      const kept = await reloadChat();
      if (outcome.kind === 'changed') {
        setPicked(null);
        await Promise.all([loadFiles(), loadVersions()]);
      }
      if (!alive.current) return;
      setLive(null);
      setJobId(null);
      abort.current = null;
      if (outcome.kind === 'failed') setRunError(ctl.signal.aborted ? null : outcome.error);
      else if (outcome.kind === 'changed') setNotice(`${changeSummary(outcome.files, pagesRef.current)} It's in your draft — undo it any time.`);
      // A message the server never took (refused before the run began) goes back into the box instead of vanishing.
      if (userText !== null && kept && !kept.slice(-2).some((l) => l.role === 'user' && l.content === userText)) setText((cur) => cur || userText);
      onChanged();
    },
    [running, moving, lines, picked, projectId, reloadChat, loadFiles, loadVersions, onChanged],
  );

  const stop = async () => {
    const id = jobId ?? resumedJobId;
    if (id) await cancelStageRun(id).catch(() => {});
    abort.current?.abort();
  };

  const move = async (action: HistoryAction, seq?: number) => {
    if (running || moving) return;
    setMoving(true);
    setNotice(null);
    setRunError(null);
    try {
      const out = await moveHistory(projectId, action, seq);
      if (!alive.current) return;
      setNotice(moveNotice(action, out));
      if (out.moved) {
        setPicked(null);
        await Promise.all([loadFiles(), loadVersions()]);
        if (alive.current) onChanged();
      } else {
        await loadVersions();
      }
    } catch (e) {
      if (alive.current) setNotice(message(e));
    } finally {
      if (alive.current) setMoving(false);
    }
  };

  const recheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await recheckSite(projectId);
      if (alive.current) onChanged();
    } catch (e) {
      if (alive.current) setCheckError(message(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const h = historyState(versions);
  const locked = running || moving || busy;

  return (
    <div class="tweaks-stage" data-testid="tweaks-stage" data-busy={locked}>
      <div class="plan-head">
        <h2>Fine-tune your site</h2>
        <span class="pill" data-testid="tweaks-draft" title={draftNote(published)}>{published ? 'Draft · live site unchanged' : 'Draft · not live yet'}</span>
      </div>

      {!manifest ? (
        <div class="notice" role="status" data-testid="tweaks-blocker">{blocker}</div>
      ) : (
        <div class="tweaks-grid">
          <div class="tweaks-main">
            {blocker && (
              <div class="notice" role="status" data-testid="tweaks-blocker">
                {blocker}
                {planStale && <button type="button" class="btn small ghost" disabled={busy} data-testid="tweaks-keep-plan" onClick={() => onKeep('plan')}>Keep plan as it is</button>}
                {styleStale && <button type="button" class="btn small ghost" disabled={busy} data-testid="tweaks-keep-style" onClick={() => onKeep('style_spec')}>Keep style as it is</button>}
              </div>
            )}
            {manifestRow?.stale && (
              <div class="notice" role="status" data-testid="tweaks-outdated">
                Your plan or style changed after this site was built.
                <button type="button" class="btn small ghost" disabled={busy} data-testid="tweaks-keep-site" onClick={() => onKeep('manifest')}>Keep it as it is</button>
              </div>
            )}
            <div class="history-bar" data-testid="tweaks-history">
              <div class="history-buttons">
                <button type="button" class="btn small ghost" disabled={locked || !h.canUndo} title={h.undoTo ? `Back to “${h.undoTo.label}”` : 'Nothing to undo'} data-testid="tweaks-undo" onClick={() => void move('undo')}>↶ Undo</button>
                <button type="button" class="btn small ghost" disabled={locked || !h.canRedo} title={h.redoTo ? `Forward to “${h.redoTo.label}”` : 'Nothing to redo'} data-testid="tweaks-redo" onClick={() => void move('redo')}>Redo ↷</button>
              </div>
              <span class="sub small history-now" data-testid="tweaks-now">{h.current ? `Now: ${versionLine(h.current)}` : 'No saved versions yet — the first one is saved with your first change.'}</span>
            </div>

            <div class={'preview-wrap' + (running || moving ? ' busy' : '')}>
              {files && files[pages[0]?.file ?? 'index.html'] !== undefined ? (
                <SitePreview projectId={projectId} pages={pages} files={files} pick={pickOn} onPick={onPick} picked={picked} onPageChange={onPage} onProblem={setProblem} onMissingPage={setMissing} />
              ) : filesError ? (
                <div class="error" role="alert" data-testid="tweaks-files-error">Couldn't load your site to show it: {filesError}</div>
              ) : (
                <div class="sk example-sk" aria-hidden="true" data-testid="tweaks-files-loading" />
              )}
            </div>
            {problem && <div class="notice" role="status" data-testid="preview-problem">A page reported an error: {problem}</div>}
            {missing && (
              <div class="notice" role="status" data-testid="preview-missing-page">
                “{missing}” isn't a page of your site.
                <button type="button" class="btn small ghost" onClick={() => setMissing(null)}>OK</button>
              </div>
            )}
            {notice && <div class="notice good" role="status" data-testid="tweaks-notice">{notice}</div>}
            <p class="sub small" data-testid="tweaks-draft-note">{draftNote(published)}</p>

            {versions.length > 1 && (
              <details class="redo versions" data-testid="tweaks-versions">
                <summary>Earlier versions ({versions.length})</summary>
                <ol class="version-list">
                  {newestFirst(versions).map((v) => (
                    <li key={v.seq} class={'version' + (v.current ? ' current' : '')} data-testid="tweaks-version" data-seq={v.seq} data-current={v.current}>
                      <span class="version-kind">{KIND_LABELS[v.kind]}</span>
                      <span class="version-line">{versionLine(v)}</span>
                      {v.current ? <span class="pill ok">You are here</span> : <button type="button" class="btn small ghost" disabled={locked} data-testid="tweaks-restore" onClick={() => void move('restore', v.seq)}>Go back to this</button>}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {view ? (
              <section class={'report compact' + (view.ok ? ' ok' : ' bad')} aria-label="Launch checks" data-testid="tweaks-report" data-ok={view.ok}>
                <div class="plan-head">
                  <h3>{view.ok ? '✓ ' : ''}{view.headline}</h3>
                  <button type="button" class="btn small ghost" disabled={checking || locked} data-testid="tweaks-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check again'}</button>
                </div>
                {reportOutdated && <p class="sub small" data-testid="report-outdated">This report is for an older version of the site. Check again for a fresh one.</p>}
                {checkError && <div class="error" role="alert" data-testid="tweaks-check-error">{checkError}</div>}
                {view.fails.length > 0 && (
                  <ul class="checks fail" data-testid="report-fails">
                    {view.fails.slice(0, 4).map((c) => <li key={c.id + (c.page ?? '')}><b>{c.label}</b>{c.page && <span class="check-page"> · {c.page}</span>}{c.detail && <span class="check-detail">{c.detail}</span>}</li>)}
                  </ul>
                )}
              </section>
            ) : (
              <div class="notice" role="status" data-testid="tweaks-no-report">
                No launch check has run for this site yet.
                <button type="button" class="btn small ghost" disabled={checking || locked} data-testid="tweaks-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check now'}</button>
              </div>
            )}
          </div>

          <TweaksChat
            lines={lines}
            loaded={loaded}
            live={live}
            resumed={resumedJobId !== null}
            error={runError}
            picked={picked}
            pickOn={pickOn}
            onPickToggle={() => setPickOn((on) => !on)}
            blocked={blocker !== null}
            onClearPicked={() => setPicked(null)}
            text={text}
            onText={setText}
            onSend={() => void send(text.trim())}
            onRetry={() => void send(null)}
            onStop={() => void stop()}
          />
        </div>
      )}
    </div>
  );
}

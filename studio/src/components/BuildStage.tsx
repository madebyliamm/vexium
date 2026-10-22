import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getBuildProgress, getSiteFiles, recheckSite, startBuild, type BuildProgress } from '../api/build.ts';
import { cancelStageRun } from '../api/stages.ts';
import {
  BUILD_NOTE_MAX, BUILD_STATUS_LABELS, backendSummary, buildBlocker, buildStatus, checklist, formatCost, headline, progress, readManifest,
  readReport, reportView, totalCost, type SitePage,
} from '../lib/build-view.ts';
import { jobIsLive } from '../lib/stage-view.ts';
import type { ArtifactKind, LatestArtifacts } from '../lib/stages.ts';
import { SitePreview } from './SitePreview.tsx';

interface Props {
  projectId: string;
  artifacts: LatestArtifacts;
  /** A build that started before this page loaded (or in another tab) is still going: its build_jobs id. */
  resumedJobId: string | null;
  busy: boolean;
  /** "Still fine, keep it" on a stale plan / style / site. */
  onKeep: (kind: ArtifactKind) => void;
  /** Something changed on the server (a build started or ended, a report was saved): re-read the project. */
  onChanged: () => void;
}

const POLL_MS = 3000;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The guided FULL BUILD screen: one button builds every page from the plan in the locked style, a checklist shows the work as it
 * happens (it keeps going if the tab is closed), then the launch report and the whole site, page by page, to click through.
 */
export function BuildStage({ projectId, artifacts, resumedJobId, busy, onKeep, onChanged }: Props) {
  const alive = useRef(true);
  const [started, setStarted] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [prog, setProg] = useState<BuildProgress | null>(null);
  const [files, setFiles] = useState<{ version: number; files: Record<string, string> } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  const manifestRow = artifacts.manifest ?? null;
  const manifest = manifestRow ? readManifest(manifestRow.data) : null;
  const planRow = artifacts.plan ?? null;
  const styleRow = artifacts.style_spec ?? null;
  const reportRow = artifacts.launch_checks ?? null;
  const report = reportRow ? readReport(reportRow.data) : null;
  const running = starting || started !== null || resumedJobId !== null;
  const job = prog?.job ?? null;
  const steps = running && prog ? prog.steps : [];

  // A failed run matters only if it is newer than the site on screen (an older failure was followed by a good build).
  const failedJob = !running && job?.status === 'failed' && (!manifest?.builtAt || Date.parse(job.created_at) > Date.parse(manifest.builtAt)) ? job : null;
  const status = buildStatus({ running, built: manifest !== null, stale: manifestRow?.stale === true, failed: failedJob !== null });
  const blocker = buildBlocker({
    hasPlan: planRow !== null,
    planStale: planRow?.stale === true,
    hasStyle: styleRow !== null,
    styleStale: styleRow?.stale === true,
    styleLocked: styleRow?.data.locked === true,
  });

  const loadProgress = useCallback(async () => {
    try {
      const p = await getBuildProgress(projectId);
      if (alive.current) setProg(p);
      return p;
    } catch {
      return null; // the next poll tries again
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void loadProgress();
    return () => {
      alive.current = false;
    };
  }, [loadProgress]);

  // While a build runs, follow its checklist. When the run is over, let the project page re-read what it saved.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void loadProgress().then((p) => {
        if (!alive.current || !p?.job) return;
        if (started && p.job.id === started && !jobIsLive(p.job)) {
          setStarted(null);
          onChanged();
        }
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, started, loadProgress, onChanged]);

  // The built site's files, for the preview: read again whenever a new version of the site was saved.
  const manifestVersion = manifestRow?.version ?? 0;
  useEffect(() => {
    if (!manifest || running) return;
    let current = true;
    setFilesError(null);
    getSiteFiles(projectId, manifest.pages).then(
      (f) => { if (current && alive.current) setFiles({ version: manifestVersion, files: f }); },
      (e) => { if (current && alive.current) setFilesError(message(e)); },
    );
    return () => { current = false; };
  }, [manifestVersion, running, projectId]);

  const start = async () => {
    if (running || blocker) return;
    setStartError(null);
    setStarting(true);
    try {
      const out = await startBuild(projectId, note);
      if (!alive.current) return;
      setStarted(out.jobId);
      setNote('');
      onChanged();
    } catch (e) {
      if (alive.current) setStartError(message(e));
    } finally {
      if (alive.current) setStarting(false);
    }
    void loadProgress();
  };

  const stop = async () => {
    const id = started ?? resumedJobId ?? job?.id;
    if (id) await cancelStageRun(id).catch(() => {});
    void loadProgress();
    onChanged();
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

  const items = checklist(steps);
  const pct = progress(steps);
  const view = report ? reportView(report) : null;
  const reportOutdated = !!report && manifestRow !== null && report.manifest_version !== manifestRow.version;
  const cost = running ? totalCost(steps) : manifest?.costCents ?? null;
  const sitePages: SitePage[] = manifest?.pages ?? [];
  const backend = manifest ? backendSummary(manifest.backend) : '';

  return (
    <div class="build-stage" data-testid="build-stage" data-status={status}>
      <div class="plan-head">
        <h2>Your full site</h2>
        <span class={'pill' + (status === 'built' ? ' ok' : status === 'outdated' || status === 'failed' ? ' warn' : '')} data-testid="build-status">{BUILD_STATUS_LABELS[status]}</span>
      </div>

      {running ? (
        <div class="example-running" data-testid="build-running" role="status">
          <p class="build-headline" data-testid="build-headline"><span class="spinner inline" aria-hidden="true" />{starting ? 'Starting your build…' : headline(steps)}</p>
          <div class="bar" role="progressbar" aria-label="Build progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct.percent} data-testid="build-bar">
            <span style={{ width: pct.percent + '%' }} />
          </div>
          {items.length > 0 && (
            <ol class="progress build-list" data-testid="build-progress">
              {items.map((it) => (
                <li key={it.seq} class={'prog ' + it.state} data-state={it.state} data-kind={it.kind}>
                  {it.state === 'done' ? <span class="tick" aria-hidden="true">✓</span>
                    : it.state === 'active' ? <span class="spinner inline" aria-hidden="true" />
                    : it.state === 'failed' ? <span class="tick bad" aria-hidden="true">✕</span>
                    : it.state === 'skipped' ? <span class="tick todo" aria-hidden="true">–</span>
                    : <span class="tick todo" aria-hidden="true">○</span>}
                  <span class="prog-label">{it.label}</span>
                  {it.note && <span class="prog-note">{it.note}</span>}
                </li>
              ))}
            </ol>
          )}
          <p class="sub small" data-testid="build-cost">{cost !== null && cost > 0 ? `Cost so far: ${formatCost(cost)}. ` : ''}A full site takes a few minutes. It keeps building if you close this page.</p>
          <button type="button" class="btn small ghost" disabled={starting} data-testid="build-stop" onClick={() => void stop()}>Stop</button>
        </div>
      ) : manifest ? (
        <div class="build-done" data-testid="build-done">
          <p class="sub" data-testid="build-summary">
            {manifest.pages.length === 1 ? '1 page' : `${manifest.pages.length} pages`}
            {backend && ` · ${backend}`}
            {cost !== null && cost > 0 && <> · <span data-testid="build-cost">Build cost {formatCost(cost)}</span></>}
          </p>
          {manifestRow?.stale && (
            <div class="notice" role="status" data-testid="build-outdated">
              Your plan or style changed after this site was built.
              <button type="button" class="btn small ghost" disabled={busy} data-testid="build-keep" onClick={() => onKeep('manifest')}>Keep it as it is</button>
            </div>
          )}
        </div>
      ) : (
        <div class="example-empty" data-testid="build-empty">
          <p class="sub">I'll build every page in your plan, in your locked style, with working forms, checkout and accounts wherever your plan needs them. Then I check every link and every button before you launch.</p>
          {blocker ? (
            <div class="notice" role="status" data-testid="build-blocker">
              {blocker}
              {planRow?.stale && <button type="button" class="btn small ghost" disabled={busy} data-testid="keep-plan" onClick={() => onKeep('plan')}>Keep plan as it is</button>}
              {!planRow?.stale && styleRow?.stale && <button type="button" class="btn small ghost" disabled={busy} data-testid="keep-style" onClick={() => onKeep('style_spec')}>Keep style as it is</button>}
            </div>
          ) : (
            <>
              <textarea
                rows={2}
                value={note}
                maxLength={BUILD_NOTE_MAX}
                placeholder="Anything to keep in mind? (optional) e.g. keep the copy short"
                aria-label="Direction for the build (optional)"
                data-testid="build-note-input"
                onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)}
              />
              <button type="button" class="btn" disabled={starting || busy} data-testid="build-start" onClick={() => void start()}>Build my full site</button>
              <p class="sub small">Takes a few minutes. It keeps going if you leave.</p>
            </>
          )}
        </div>
      )}

      {startError && !running && <div class="error" role="alert" data-testid="build-start-error">{startError}</div>}
      {failedJob && (
        <div class="error" role="alert" data-testid="build-failed">
          {manifest ? 'That build was not saved — your earlier site is unchanged.' : 'Nothing was saved, so you can start the build again.'}
        </div>
      )}

      {!running && manifest && view && (
        <section class={'report' + (view.ok ? ' ok' : ' bad')} aria-label="Launch checks" data-testid="build-report" data-ok={view.ok}>
          <div class="plan-head">
            <h3>{view.ok ? '✓ ' : ''}{view.headline}</h3>
            <button type="button" class="btn small ghost" disabled={checking || busy} data-testid="build-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
          {reportOutdated && <p class="sub small" data-testid="report-outdated">This report is for an older version of the site. Check again for a fresh one.</p>}
          {checkError && <div class="error" role="alert" data-testid="build-check-error">{checkError}</div>}
          {view.fails.length > 0 && (
            <ul class="checks fail" data-testid="report-fails">
              {view.fails.map((c) => <li key={c.id + (c.page ?? '')}><b>{c.label}</b>{c.page && <span class="check-page"> · {c.page}</span>}{c.detail && <span class="check-detail">{c.detail}</span>}</li>)}
            </ul>
          )}
          {view.warns.length > 0 && (
            <ul class="checks warn" data-testid="report-warns">
              {view.warns.map((c) => <li key={c.id + (c.page ?? '')}><b>{c.label}</b>{c.page && <span class="check-page"> · {c.page}</span>}{c.detail && <span class="check-detail">{c.detail}</span>}</li>)}
            </ul>
          )}
          {view.openItems.length > 0 && (
            <div data-testid="report-open">
              <p class="sub small"><b>Still to do before you launch</b></p>
              <ul class="checks open">{view.openItems.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          )}
          {view.passes.length > 0 && (
            <details data-testid="report-passes">
              <summary>{view.passes.length} {view.passes.length === 1 ? 'check' : 'checks'} passed</summary>
              <ul class="checks pass">{view.passes.map((c) => <li key={c.id + (c.page ?? '')}>{c.label}</li>)}</ul>
            </details>
          )}
        </section>
      )}
      {!running && manifest && !view && (
        <div class="notice" role="status" data-testid="build-no-report">
          No launch check has run for this site yet.
          <button type="button" class="btn small ghost" disabled={checking || busy} data-testid="build-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check now'}</button>
        </div>
      )}

      {!running && manifest && (
        files && files.files[sitePages[0]?.file ?? 'index.html'] !== undefined ? (
          <div class="preview-wrap">
            <SitePreview projectId={projectId} pages={sitePages} files={files.files} onProblem={setProblem} onMissingPage={setMissing} key={files.version} />
          </div>
        ) : filesError ? (
          <div class="error" role="alert" data-testid="build-files-error">Couldn't load your site to show it: {filesError}</div>
        ) : (
          <div class="sk example-sk" aria-hidden="true" data-testid="build-files-loading" />
        )
      )}
      {problem && !running && <div class="notice" role="status" data-testid="preview-problem">A page reported an error: {problem}</div>}
      {missing && (
        <div class="notice" role="status" data-testid="preview-missing-page">
          “{missing}” isn't a page of your site.
          <button type="button" class="btn small ghost" onClick={() => setMissing(null)}>OK</button>
        </div>
      )}

      {!running && manifest && (
        <details class="redo" data-testid="build-redo-box">
          <summary>Want to build it again?</summary>
          <p class="sub small">Builds every page again from your plan and locked style. The site you have now stays until the new one is complete and checked.</p>
          <textarea
            rows={2}
            value={note}
            maxLength={BUILD_NOTE_MAX}
            placeholder="What should be different? (optional)"
            aria-label="What should be different (optional)"
            data-testid="build-redo-note"
            onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)}
          />
          <button type="button" class="btn ghost" disabled={starting || busy || !!blocker} data-testid="build-redo" onClick={() => void start()}>Build it again</button>
          {blocker && <p class="sub small">{blocker}</p>}
        </details>
      )}
    </div>
  );
}

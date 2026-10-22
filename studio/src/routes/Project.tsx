import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { cancelStageRun, getLatestStageJob, getStageState, keepArtifact, moveToStage, StageError, type StageState } from '../api/stages.ts';
import { BuildStage } from '../components/BuildStage.tsx';
import { ExampleStage } from '../components/ExampleStage.tsx';
import { PlanStage } from '../components/PlanStage.tsx';
import { Splash } from '../components/Splash.tsx';
import { StagePanel } from '../components/StagePanel.tsx';
import { StageStepper } from '../components/StageStepper.tsx';
import { LEGACY } from '../lib/config.ts';
import { planHints, readPlan } from '../lib/plan-view.ts';
import { buildSteps, jobFailedRecently, jobIsLive, type Step } from '../lib/stage-view.ts';
import { STAGE_LABELS, describeBlocker, type ArtifactKind, type Stage } from '../lib/stages.ts';

const POLL_MS = 4000;

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; state: StageState | null };

export function Project({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The PLAN card holds edits that are not saved yet. */
  const [planDirty, setPlanDirty] = useState(false);
  /** The EXAMPLE controls hold style changes that are not saved yet. */
  const [exampleDirty, setExampleDirty] = useState(false);
  const alive = useRef(true);

  /** Re-read everything WITHOUT going back to the loading screen (an action shouldn't flash the page). */
  const refresh = useCallback(async () => {
    try {
      const state = await getStageState(id);
      if (alive.current) setLoad({ status: 'ready', state });
    } catch (e) {
      if (alive.current) setLoad({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    setLoad({ status: 'loading' });
    setNotice(null);
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // A stage run is going (started before a refresh, or in another tab): poll the job until it ends, then reload what it saved.
  const state = load.status === 'ready' ? load.state : null;
  const runningJobId = state && jobIsLive(state.job) ? state.job?.id : undefined;
  useEffect(() => {
    if (!runningJobId) return;
    const timer = setInterval(() => {
      getLatestStageJob(id).then((job) => {
        if (!jobIsLive(job) || job?.id !== runningJobId) void refresh();
      }, () => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [runningJobId, id, refresh]);

  const act = useCallback(async (work: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await work());
    } catch (e) {
      setNotice(e instanceof StageError || e instanceof Error ? e.message : String(e));
    }
    await refresh();
    if (alive.current) setBusy(false);
  }, [refresh]);

  const move = (stage: Stage) =>
    act(async () => {
      const r = await moveToStage(id, stage);
      return r.ok ? null : `${STAGE_LABELS[stage]}: ${r.blockedBy.map(describeBlocker).join('. ')}.`;
    });
  const keep = (kind: ArtifactKind) => act(async () => (await keepArtifact(id, kind), null));
  const stop = (jobId: string) => act(async () => (await cancelStageRun(jobId), null));

  const pick = (step: Step) => {
    if (busy || step.state === 'current') return;
    if (step.state === 'blocked') setNotice(`${step.label}: ${step.blockedBy.map(describeBlocker).join('. ')}.`);
    else void move(step.stage);
  };

  if (load.status === 'loading') return <Splash />;
  if (load.status === 'error') {
    return <main class="page"><div class="error" role="alert">Couldn't load this project: {load.error}</div></main>;
  }
  if (!state) {
    return (
      <main class="page">
        <div class="crumbs"><a href="#/">Projects</a></div>
        <h1>Project not found</h1>
        <p class="sub">It may have been deleted, or you don't have access to it.</p>
      </main>
    );
  }

  const { project, artifacts, job } = state;
  const steps = buildSteps(project.stage, artifacts, project.published);
  const planArtifact = artifacts.plan;
  const planStage = project.stage === 'plan';
  const exampleStage = project.stage === 'example';
  const buildStage = project.stage === 'build';
  const styleArtifact = artifacts.style_spec;
  const hints = planStage && planArtifact && !planDirty ? planHints(readPlan(planArtifact.data, project.name || 'Untitled')) : [];
  return (
    <main class="page">
      <div class="crumbs"><a href="#/">Projects</a> / {project.name || 'Untitled'}</div>
      <div class="page-head">
        <h1>{project.emoji || '💻'} {project.name || 'Untitled'}</h1>
        <a class="btn" href={LEGACY.editor(project.id)}>Open in editor</a>
      </div>
      <div class="stack">
        {runningJobId && job && (
          <div class="notice" role="status" data-testid="job-running">
            <span class="spinner inline" aria-hidden="true" /> Still working on your {STAGE_LABELS[job.stage].toLowerCase()} step — you can leave this page, it will be here when you come back.
            <button type="button" class="btn small ghost" disabled={busy} data-testid="job-stop" onClick={() => void stop(job.id)}>Stop</button>
          </div>
        )}
        {!runningJobId && jobFailedRecently(job) && (
          <div class="error" role="status" data-testid="job-failed">The last {STAGE_LABELS[job!.stage].toLowerCase()} run didn't finish: {job!.error}</div>
        )}
        {notice && <div class="error" role="alert" data-testid="stage-notice">{notice}</div>}
        <StageStepper steps={steps} busy={busy} onPick={pick} />
        <StagePanel
          projectId={project.id}
          stage={project.stage}
          artifacts={artifacts}
          published={project.published}
          busy={busy}
          onKeep={(k) => void keep(k)}
          onMove={(s) => void move(s)}
          holdContinue={planStage && planDirty ? 'Save your plan changes first.' : exampleStage && exampleDirty ? 'Save or discard your style changes first.' : buildStage && runningJobId ? 'Your site is still being built.' : null}
          continueNote={hints.length > 0 ? `You can continue now. You may still want to ${hints.join(', ')}.` : null}
          guided={
            planStage ? (
              <PlanStage
                projectId={project.id}
                projectName={project.name}
                saved={planArtifact ? { version: planArtifact.version, data: planArtifact.data } : null}
                resumedJobId={runningJobId ?? null}
                onChanged={() => { setNotice(null); void refresh(); }}
                onDirtyChange={setPlanDirty}
              />
            ) : exampleStage ? (
              <ExampleStage
                projectId={project.id}
                saved={styleArtifact ? { version: styleArtifact.version, data: styleArtifact.data } : null}
                resumedJobId={runningJobId ?? null}
                onChanged={() => { setNotice(null); void refresh(); }}
                onDirtyChange={setExampleDirty}
              />
            ) : buildStage ? (
              <BuildStage
                projectId={project.id}
                artifacts={artifacts}
                resumedJobId={runningJobId ?? null}
                busy={busy}
                onKeep={(k) => void keep(k)}
                onChanged={() => { setNotice(null); void refresh(); }}
              />
            ) : undefined
          }
        />
      </div>
    </main>
  );
}

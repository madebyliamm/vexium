import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JOB_FAILED_SHOWN_MS, JOB_LIVE_MS, artifactCards, buildSteps, continueBlockers, describeStageError, jobFailedRecently, jobIsLive, parseJob,
  parseMoveResult, rowsToLatest, type StageJob,
} from '../src/lib/stage-view.ts';
import { applyPut, type ArtifactKind, type LatestArtifacts } from '../src/lib/stages.ts';

const fresh = (...kinds: ArtifactKind[]): LatestArtifacts => {
  let l: LatestArtifacts = {};
  for (const k of kinds) l = applyPut(l, k, k === 'style_spec' ? { schema: 1, locked: true } : { schema: 1 }).latest;
  return l;
};

describe('rowsToLatest', () => {
  it('maps latest-view rows, ignoring unknown kinds and junk', () => {
    const l = rowsToLatest([
      { kind: 'plan', version: 3, stale: false, data: { name: 'A' } },
      { kind: 'manifest', version: 1, stale: true, data: null },
      { kind: 'style_spec', version: 2, stale: false, data: [1] },
      { kind: 'bogus', version: 1, stale: false, data: {} },
      { kind: 'launch_checks', version: 'x', stale: false, data: {} },
    ]);
    assert.deepEqual(l, {
      plan: { version: 3, stale: false, data: { name: 'A' } },
      manifest: { version: 1, stale: true, data: {} },
      style_spec: { version: 2, stale: false, data: {} },
    });
  });
});

describe('parseMoveResult', () => {
  it('reads an ok result and a blocked one', () => {
    assert.deepEqual(parseMoveResult({ ok: true, stage: 'example', blocked_by: [] }), { ok: true, stage: 'example', blockedBy: [] });
    assert.deepEqual(parseMoveResult({ ok: false, stage: 'plan', blocked_by: [{ kind: 'plan', reason: 'missing' }, { kind: 'published', reason: 'missing' }, { kind: 'zzz', reason: 'x' }] }), {
      ok: false, stage: 'plan', blockedBy: [{ kind: 'plan', reason: 'missing' }, { kind: 'published', reason: 'missing' }],
    });
  });
  it('throws on an answer the engine cannot have produced', () => {
    for (const bad of [null, 'x', {}, { ok: 'yes', stage: 'plan' }, { ok: true, stage: 'nowhere' }]) assert.throws(() => parseMoveResult(bad), /Unexpected/);
  });
});

describe('describeStageError', () => {
  it('words the engine\'s error codes', () => {
    assert.match(describeStageError({ code: 'PT409', message: 'version conflict' }), /changed somewhere else/);
    assert.match(describeStageError({ code: '40001' }), /changed somewhere else/);
    assert.match(describeStageError({ code: '42501', message: 'project not found or not allowed' }), /don't have access/);
    assert.match(describeStageError({ code: '54000' }), /too large/);
    assert.equal(describeStageError({ code: 'XX', message: ' boom ' }), 'boom');
    assert.match(describeStageError({}), /Something went wrong/);
  });
});

describe('jobs', () => {
  const NOW = Date.parse('2026-10-14T12:00:00Z');
  const job = (over: Partial<StageJob> = {}): StageJob => ({ id: 'j', stage: 'plan', status: 'running', created_at: '2026-10-14T11:59:50Z', heartbeat_at: null, finished_at: null, error: null, ...over });

  it('parseJob keeps stage jobs and drops the old editor\'s rows and junk', () => {
    assert.deepEqual(parseJob({ id: 'a', stage: 'plan', status: 'failed', created_at: 't', heartbeat_at: 'h', finished_at: 'f', error: 'boom' }), { id: 'a', stage: 'plan', status: 'failed', created_at: 't', heartbeat_at: 'h', finished_at: 'f', error: 'boom' });
    assert.equal(parseJob({ id: 'a', stage: null, status: 'running', created_at: 't' }), null);
    assert.equal(parseJob({ id: 'a', stage: 'plan', status: 'weird', created_at: 't' }), null);
    assert.equal(parseJob(null), null);
    assert.equal(parseJob({ id: 'a', stage: 'plan', status: 'running', created_at: 't', error: '' })?.error, null);
  });

  it('a running job is live while the Worker keeps stamping its heartbeat — a silent one is dead (the Worker was killed)', () => {
    assert.equal(jobIsLive(job(), NOW), true, 'just created, no heartbeat yet');
    assert.equal(jobIsLive(job({ created_at: '2026-10-14T11:00:00Z', heartbeat_at: '2026-10-14T11:59:55Z' }), NOW), true, 'old run, fresh heartbeat');
    assert.equal(jobIsLive(job({ created_at: '2026-10-14T11:00:00Z', heartbeat_at: new Date(NOW - JOB_LIVE_MS - 1000).toISOString() }), NOW), false, 'heartbeat went silent');
    assert.equal(jobIsLive(job({ created_at: new Date(NOW - JOB_LIVE_MS - 1000).toISOString() }), NOW), false, 'never got a first heartbeat');
    assert.equal(jobIsLive(job({ status: 'complete' }), NOW), false);
    assert.equal(jobIsLive(job({ created_at: 'garbage' }), NOW), false);
    assert.equal(jobIsLive(null, NOW), false);
  });

  it('a failure is shown for an hour, only if it has a message', () => {
    const failed = job({ status: 'failed', error: 'Stopped', finished_at: '2026-10-14T11:50:00Z' });
    assert.equal(jobFailedRecently(failed, NOW), true);
    assert.equal(jobFailedRecently({ ...failed, finished_at: new Date(NOW - JOB_FAILED_SHOWN_MS - 1000).toISOString() }, NOW), false);
    assert.equal(jobFailedRecently({ ...failed, error: null }, NOW), false);
    assert.equal(jobFailedRecently(job(), NOW), false);
  });
});

describe('buildSteps', () => {
  it('a brand-new project: plan is current and everything else is blocked on the plan', () => {
    const steps = buildSteps('plan', {}, false);
    assert.deepEqual(steps.map((s) => [s.stage, s.state]), [['plan', 'current'], ['example', 'blocked'], ['build', 'blocked'], ['tweaks', 'blocked'], ['launch', 'blocked'], ['business', 'blocked']]);
    assert.deepEqual(steps[1]!.blockedBy, [{ kind: 'plan', reason: 'missing' }]);
    assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.ok(steps.every((s) => !s.attention));
  });

  it('with a plan, example opens; earlier stages are "past"; later ones stay blocked', () => {
    const steps = buildSteps('example', fresh('plan'), false);
    assert.deepEqual(steps.map((s) => s.state), ['past', 'current', 'blocked', 'blocked', 'blocked', 'blocked']);
    const next = buildSteps('plan', fresh('plan'), false);
    assert.equal(next[1]!.state, 'open');
  });

  it('a stale artifact flags the stage that produces it', () => {
    const stale = applyPut(fresh('plan', 'style_spec', 'manifest'), 'plan', { schema: 1 }).latest;
    const steps = buildSteps('tweaks', stale, false);
    const att = Object.fromEntries(steps.map((s) => [s.stage, s.attention]));
    assert.deepEqual(att, { plan: false, example: true, build: true, tweaks: true, launch: false, business: false });
    assert.equal(steps.find((s) => s.stage === 'launch')!.state, 'blocked');
  });

  it('business opens once something is published', () => {
    assert.equal(buildSteps('plan', {}, true).at(-1)!.state, 'open');
    assert.equal(buildSteps('plan', {}, false).at(-1)!.state, 'blocked');
  });
});

describe('artifactCards / continueBlockers', () => {
  it('lists what a stage reads and works on, with keep offered only for stale, member-keepable kinds', () => {
    const l = applyPut(fresh('plan', 'style_spec', 'manifest', 'launch_checks'), 'plan', { schema: 1 }).latest;
    const cards = artifactCards('tweaks', l);
    assert.deepEqual(cards.map((c) => [c.kind, c.role, c.version, c.stale, c.keepable]), [
      ['plan', 'input', 2, false, false],
      ['style_spec', 'input', 1, true, true],
      ['manifest', 'working', 1, true, true],
    ]);
    const launch = artifactCards('launch', l);
    assert.deepEqual(launch.map((c) => [c.kind, c.stale, c.keepable]), [['manifest', true, true], ['launch_checks', true, false]]);
  });

  it('a stage that works on one of its inputs lists it once', () => {
    assert.deepEqual(artifactCards('plan', fresh('plan')).map((c) => [c.kind, c.role]), [['plan', 'working']]);
  });

  it('missing artifacts show version null', () => {
    assert.deepEqual(artifactCards('example', {}).map((c) => [c.kind, c.version]), [['plan', null], ['style_spec', null]]);
  });

  it('continueBlockers = what stands between this stage and the next; nothing after the last stage', () => {
    assert.deepEqual(continueBlockers('plan', {}, false), [{ kind: 'plan', reason: 'missing' }]);
    assert.deepEqual(continueBlockers('plan', fresh('plan'), false), []);
    assert.deepEqual(continueBlockers('business', {}, false), []);
  });
});

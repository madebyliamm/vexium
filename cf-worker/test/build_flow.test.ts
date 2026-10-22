// FULL BUILD control flow — run:  node --test cf-worker/test/build_flow.test.ts
// The flow is driven with a fake step runner (durable steps with retries, like a Cloudflare Workflow) and a fake ai-chat.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pool, runBuild, type BuildPorts, type ModelRequest, type ModelResult, type OpResult, type Steps } from '../build-flow.ts';

const tick = () => new Promise<void>((r) => setImmediate(r));
const USAGE = { in: 100, out: 2000, cacheWrite: 0, cacheRead: 5000 };
const HTML = (t: string) => `<!DOCTYPE html><html><body><h1>${t}</h1></body></html>`;

/** A step runner that behaves like Workflows: names must be unique, a throwing step is retried `retries` more times. */
function fakeSteps() {
  const names: string[] = [];
  const sleeps: [string, number][] = [];
  const opts: Record<string, { retries: number; timeout: string }> = {};
  const seen = new Set<string>();
  const steps: Steps = {
    async run(name, o, cb) {
      assert.ok(!seen.has(name), `step name used twice: ${name}`);
      seen.add(name);
      names.push(name);
      opts[name] = o;
      let last: unknown;
      for (let i = 0; i <= o.retries; i++) {
        try { return await cb(); } catch (e) {
          last = e;
          if ((e as Error).name === 'NonRetry') break;
        }
      }
      throw last;
    },
    async sleep(name, seconds) {
      assert.ok(!seen.has(name), `step name used twice: ${name}`);
      seen.add(name);
      sleeps.push([name, seconds]);
      await tick();
    },
  };
  return { steps, names, sleeps, opts };
}

interface Script {
  pages?: { seq: number; file: string }[];
  /** Pages that only exist as repairs: the model can write them, but the first wave does not include them. */
  repairPages?: { seq: number; file: string }[];
  /** page_done answers per `seq-attempt` (default ok). */
  report?: Record<string, OpResult>;
  /** model answers per `seq-attempt` (default: writes the page). */
  model?: Record<string, Partial<ModelResult>>;
  /** verify answers per round. */
  verify?: Record<number, OpResult>;
  start?: Record<string, OpResult>;
  complete?: OpResult;
  begin?: OpResult;
  /** ops that throw on their first N calls (network trouble). */
  flaky?: Record<string, number>;
  beat?: boolean;
  concurrency?: number;
}

function harness(script: Script = {}) {
  const ops: Record<string, unknown>[] = [];
  const modelCalls: ModelRequest[] = [];
  const reports: Record<string, unknown>[] = [];
  const events: string[] = [];
  let running = 0, peak = 0;
  const pages = script.pages ?? [{ seq: 1, file: 'index.html' }, { seq: 2, file: 'shop.html' }, { seq: 3, file: 'contact.html' }];
  const known = [...pages, ...(script.repairPages ?? [])];
  const flaky = { ...(script.flaky ?? {}) };
  const ports: BuildPorts = {
    concurrency: script.concurrency ?? 4,
    fatal: (m) => Object.assign(new Error(m), { name: 'NonRetry' }),
    beat: async () => script.beat ?? false,
    async op(body) {
      const op = String(body.op);
      ops.push(body);
      if ((flaky[op] ?? 0) > 0) { flaky[op]!--; throw new Error('network down'); }
      const key = `${body.seq}-${body.attempt}`;
      if (op === 'begin') return script.begin ?? { ok: true, model: 'm', max_tokens: 20000, system: 'SYSTEM', pages: pages.map((p) => ({ ...p, prompt: `write ${p.file}` })) };
      if (op === 'step_start') { events.push(`start ${body.seq}`); return script.start?.[String(body.seq)] ?? { ok: true }; }
      if (op === 'page_done') { reports.push(body); events.push(`report ${body.seq}`); return script.report?.[key] ?? (body.error ? { ok: false, error: String(body.error) } : { ok: true }); }
      if (op === 'verify') return script.verify?.[Number(body.round)] ?? { ok: true, final: true, repairs: [] };
      if (op === 'complete') return script.complete ?? { ok: true };
      if (op === 'fail') return { ok: true };
      throw new Error('unknown op ' + op);
    },
    async callModel(req) {
      modelCalls.push(req);
      const file = req.prompt.replace(/^write /, '');
      const seq = known.find((p) => p.file === file)?.seq ?? file;
      events.push(`model ${seq}`);
      running++; peak = Math.max(peak, running);
      await tick(); await tick();
      running--;
      const n = modelCalls.filter((c) => c.prompt === req.prompt).length;
      const over = script.model?.[`${seq}-${n}`] ?? {};
      return { files: { [file]: HTML(file) }, usage: USAGE, ...over };
    },
  };
  return { ports, ops, modelCalls, reports, events, peak: () => peak, opNames: () => ops.map((o) => String(o.op)) };
}

describe('pool', () => {
  it('runs every item, never more than the limit at once, in order of pick-up', async () => {
    let running = 0, peak = 0;
    const order: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { order.push(n); running++; peak = Math.max(peak, running); await tick(); running--; });
    assert.equal(peak, 3);
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7]);
  });
  it('handles no items and a limit larger than the list', async () => {
    await pool([], 4, async () => assert.fail('nothing to run'));
    const seen: number[] = [];
    await pool([1, 2], 10, async (n) => { seen.push(n); });
    assert.deepEqual(seen, [1, 2]);
  });
});

describe('runBuild — the normal build', () => {
  it('begins, writes every page once, checks the site, completes', async () => {
    const h = harness(), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'complete' });
    assert.deepEqual(h.opNames().filter((o) => o !== 'step_start' && o !== 'page_done'), ['begin', 'verify', 'complete']);
    assert.equal(h.modelCalls.length, 3);
    assert.ok(h.ops.every((o) => o.job_id === 'job1'), 'every operation names the job');
    for (const c of h.modelCalls) assert.deepEqual([c.model, c.max_tokens, c.system], ['m', 20000, 'SYSTEM']);
  });
  it('reports each page with its files and its usage', async () => {
    const h = harness(), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.equal(h.reports.length, 3);
    const r = h.reports.find((x) => x.seq === 2)!;
    assert.deepEqual(r, { op: 'page_done', job_id: 'job1', seq: 2, attempt: 1, usage: USAGE, files: { 'shop.html': HTML('shop.html') } });
  });
  it('every page runs with the first alone: later pages of the first wave wait for the prompt cache, the first does not', async () => {
    const h = harness(), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(s.sleeps.map(([n]) => n).sort(), ['warm-2', 'warm-3']);
    assert.ok(s.sleeps.every(([, sec]) => sec >= 3 && sec <= 15));
    assert.ok(h.events.indexOf('model 1') < h.events.indexOf('model 2'));
  });
  it('writes at most `concurrency` pages at the same time, and only the first wave waits for the cache', async () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, file: `p${i + 1}.html` }));
    const h = harness({ pages, concurrency: 3 }), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.equal(h.peak(), 3);
    assert.equal(h.modelCalls.length, 7);
    assert.deepEqual(s.sleeps.map(([n]) => n).sort(), ['warm-2', 'warm-3']);
  });
  it('gives the retrying runner what it needs: operations are retried, a model call is not (its tries are counted and billed)', async () => {
    const h = harness(), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.ok(s.opts['begin']!.retries >= 3);
    assert.ok(s.opts['report-1-1']!.retries >= 3);
    assert.equal(s.opts['write-1-1']!.retries, 0);
    assert.match(s.opts['write-1-1']!.timeout, /minutes/);
  });
  it('survives network trouble reaching ai-chat (the step runner retries the operation)', async () => {
    const h = harness({ flaky: { begin: 2, verify: 1, complete: 3 } }), s = fakeSteps();
    assert.deepEqual(await runBuild('job1', s.steps, h.ports), { outcome: 'complete' });
  });
  it('sends the heartbeat before checking the site and again before completing', async () => {
    const h = harness(), s = fakeSteps();
    let beats = 0;
    h.ports.beat = async () => { beats++; return false; };
    await runBuild('job1', s.steps, h.ports);
    assert.ok(beats >= 2);
  });
});

describe('runBuild — pages that fail', () => {
  it('a rejected page is written again as a numbered attempt, and reports the failed try\'s usage too', async () => {
    const h = harness({ report: { '2-1': { ok: false, error: 'It was empty.' } } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'complete' });
    assert.deepEqual(h.reports.filter((r) => r.seq === 2).map((r) => r.attempt), [1, 2]);
    assert.equal(h.modelCalls.filter((c) => c.prompt === 'write shop.html').length, 2);
    assert.ok(h.reports.filter((r) => r.seq === 2).every((r) => (r.usage as { out: number }).out === 2000));
  });
  it('gives up on a page after three tries; the check then asks for the repair (the build is not abandoned)', async () => {
    const bad = { ok: false, error: 'No.' };
    const h = harness({ report: { '3-1': bad, '3-2': bad, '3-3': bad } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'complete');
    assert.equal(h.reports.filter((r) => r.seq === 3).length, 3);
    assert.equal(h.opNames().filter((o) => o === 'verify').length, 1);
  });
  it('a model error is reported (with no files) and the page tried again after a pause when the service was busy', async () => {
    const h = harness({ model: { '1-1': { files: {}, error: 'The AI service is busy.', busy: true, usage: { in: 10, out: 0, cacheWrite: 0, cacheRead: 0 } } } }), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    const first = h.reports.find((r) => r.seq === 1 && r.attempt === 1)!;
    assert.equal(first.error, 'The AI service is busy.');
    assert.ok(!('files' in first));
    assert.deepEqual(first.usage, { in: 10, out: 0, cacheWrite: 0, cacheRead: 0 });
    assert.ok(s.sleeps.some(([n]) => n === 'wait-1-1'));
    assert.equal(h.reports.filter((r) => r.seq === 1).length, 2);
  });
  it('a model step that throws or times out is one failed try, reported as such, not the end of the build', async () => {
    const h = harness(), s = fakeSteps();
    const real = h.ports.callModel;
    let first = true;
    h.ports.callModel = async (req) => { if (first) { first = false; throw new Error('step timed out'); } return real(req); };
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'complete');
    const failed = h.reports.filter((r) => 'error' in r);
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.error), /did not answer in time/);
  });
  it('does not pause after a failure that is not the service being busy', async () => {
    const h = harness({ report: { '1-1': { ok: false, error: 'Too short.' } } }), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.ok(!s.sleeps.some(([n]) => n.startsWith('wait-')));
  });
});

describe('runBuild — repairs', () => {
  const repair = (seq: number, file: string) => ({ seq, file, title: file, prompt: `write ${file}` });
  it('writes each repair the check asks for, then checks again until the last round', async () => {
    const h = harness({
      pages: [{ seq: 1, file: 'index.html' }, { seq: 2, file: 'shop.html' }],
      repairPages: [{ seq: 10, file: 'x.html' }, { seq: 11, file: 'y.html' }],
      verify: { 1: { ok: true, final: false, repairs: [repair(10, 'x.html'), repair(11, 'y.html')] }, 2: { ok: true, final: true, repairs: [] } },
    }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'complete' });
    assert.deepEqual(h.opNames().filter((o) => o === 'verify').length, 2);
    assert.deepEqual(h.ops.filter((o) => o.op === 'verify').map((o) => o.round), [1, 2]);
    assert.ok(h.reports.some((r) => r.seq === 10) && h.reports.some((r) => r.seq === 11));
    assert.deepEqual(s.names.filter((n) => n.startsWith('verify-')), ['verify-1', 'verify-2']);
  });
  it('a repair gets two tries, not three', async () => {
    const bad = { ok: false, error: 'Still wrong.' };
    const h = harness({
      pages: [{ seq: 1, file: 'index.html' }],
      repairPages: [{ seq: 10, file: 'x.html' }],
      verify: { 1: { ok: true, final: false, repairs: [repair(10, 'x.html')] }, 2: { ok: true, final: true, repairs: [] } },
      report: { '10-1': bad, '10-2': bad, '10-3': bad },
    }), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports);
    assert.equal(h.reports.filter((r) => r.seq === 10).length, 2);
  });
  it('stops looping when the check returns nothing to repair even if it is not marked final', async () => {
    const h = harness({ verify: { 1: { ok: true, final: false, repairs: [] } } }), s = fakeSteps();
    assert.equal((await runBuild('job1', s.steps, h.ports)).outcome, 'complete');
    assert.equal(h.opNames().filter((o) => o === 'verify').length, 1);
  });
});

describe('runBuild — stopping', () => {
  it('the owner presses Stop (a step finds the job closed): nothing more is started, nothing is completed or failed', async () => {
    const h = harness({ start: { '2': { ok: false, closed: true } }, concurrency: 1 }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'closed' });
    assert.ok(!h.opNames().includes('complete') && !h.opNames().includes('fail') && !h.opNames().includes('verify'));
    assert.ok(!h.events.includes('model 3'));
  });
  it('the heartbeat finds the job closed', async () => {
    const h = harness({ beat: true }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'closed');
    assert.ok(!h.opNames().includes('complete'));
  });
  it('a model call that was cut by Stop reports its usage and ends the build quietly', async () => {
    const h = harness({ model: { '1-1': { files: {}, stopped: true, usage: { in: 5, out: 5, cacheWrite: 0, cacheRead: 0 } } } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'closed');
    assert.ok(h.reports.some((r) => r.seq === 1 && (r.usage as { out: number }).out === 5), 'what was generated is still billed');
    assert.ok(!h.opNames().includes('complete') && !h.opNames().includes('fail'));
  });
  it('the job was closed before it began', async () => {
    const h = harness({ begin: { ok: false, closed: true } }), s = fakeSteps();
    assert.equal((await runBuild('job1', s.steps, h.ports)).outcome, 'closed');
    assert.equal(h.modelCalls.length, 0);
  });
  it('closing during completion is not an error', async () => {
    const h = harness({ complete: { ok: false, closed: true } }), s = fakeSteps();
    assert.equal((await runBuild('job1', s.steps, h.ports)).outcome, 'closed');
  });
});

describe('runBuild — builds that cannot go on', () => {
  it('ai-chat refusing to begin (stale inputs, no access) ends it with that reason and does not call fail again', async () => {
    const h = harness({ begin: { ok: false, error: 'The plan changed. Please review it.' } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'failed', error: 'The plan changed. Please review it.' });
    assert.ok(!h.opNames().includes('fail'));
  });
  it('the credit limit stops the build and closes the job with the limit message', async () => {
    const h = harness({ start: { '1': { ok: false, stop: true, error: 'You have used all your AI credits.' } } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'failed', error: 'You have used all your AI credits.' });
    const fail = h.ops.find((o) => o.op === 'fail')!;
    assert.equal(fail.error, 'You have used all your AI credits.');
    assert.ok(!h.opNames().includes('complete'));
  });
  it('a model failure that retrying cannot fix (no credit at the provider) stops the build at once', async () => {
    const h = harness({ model: { '1-1': { files: {}, error: 'The AI service is out of credit right now. Please try again later.', fatal: true } }, concurrency: 1 }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'failed');
    assert.match(out.error!, /out of credit/);
    assert.equal(h.modelCalls.length, 1, 'no other page was started');
    assert.equal(h.reports.length, 1, 'but what was spent is reported');
    assert.ok(h.opNames().includes('fail'));
  });
  it('the check itself failing ends the build with its reason', async () => {
    const h = harness({ verify: { 1: { ok: false, error: 'The build could not be checked.' } } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.deepEqual(out, { outcome: 'failed', error: 'The build could not be checked.' });
  });
  it('completion refused (a page was never built) is a failure with the reason', async () => {
    const h = harness({ complete: { ok: false, error: '1 page could not be built (shop.html). Nothing was changed — please try again.' } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'failed');
    assert.match(out.error!, /shop\.html/);
  });
  it('ai-chat unreachable for good: the job is closed with a plain message, best effort', async () => {
    const h = harness({ flaky: { begin: 99 } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'failed');
    assert.ok(h.ops.some((o) => o.op === 'fail' && /stopped unexpectedly/.test(String(o.error))));
  });
  it('an unexpected crash mid-build closes the job; a second crash while closing it does not escape', async () => {
    const h = harness({ flaky: { verify: 99, fail: 99 } }), s = fakeSteps();
    const out = await runBuild('job1', s.steps, h.ports);
    assert.equal(out.outcome, 'failed');
  });
  it('step names are unique even when every path is taken', async () => {
    const h = harness({
      pages: [{ seq: 1, file: 'index.html' }, { seq: 2, file: 'shop.html' }],
      repairPages: [{ seq: 5, file: 'shop.html' }],
      report: { '1-1': { ok: false, error: 'x' } },
      model: { '2-1': { files: {}, error: 'busy', busy: true } },
      verify: { 1: { ok: true, final: false, repairs: [{ seq: 5, file: 'shop.html', title: 's', prompt: 'write shop.html' }] }, 2: { ok: true, final: true, repairs: [] } },
    }), s = fakeSteps();
    await runBuild('job1', s.steps, h.ports); // fakeSteps asserts on a repeated name
    assert.ok(s.names.length > 10);
  });
});

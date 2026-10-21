// run: node --test cf-worker/test/stage_report.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRun, reportStageDone, touchJob } from '../stage-report.ts';

describe('judgeRun', () => {
  it('a finished reply is a success', () => {
    assert.deepEqual(judgeRun({ aborted: false, apiError: null, message: 'Hi' }), { ok: true, message: 'Hi' });
  });
  it('Stop, an API error, or a stream that ended without a message are failures (and never save anything)', () => {
    assert.deepEqual(judgeRun({ aborted: true, apiError: null, message: 'Hi' }), { ok: false, error: 'Stopped' });
    assert.deepEqual(judgeRun({ aborted: false, apiError: 'overloaded', message: '' }), { ok: false, error: 'overloaded' });
    const cut = judgeRun({ aborted: false, apiError: null, message: '' });
    assert.equal(cut.ok, false);
    assert.match(cut.error!, /stopped before finishing/);
  });
  it('files the run wrote travel with the result (EXAMPLE saves them next to its style)', () => {
    const files = { 'styles.css': ':root{}', 'index.html': '<html></html>' };
    assert.deepEqual(judgeRun({ aborted: false, apiError: null, message: 'Here it is.', files }), { ok: true, message: 'Here it is.', files });
    assert.deepEqual(judgeRun({ aborted: false, apiError: null, message: 'Hi', files: {} }), { ok: true, message: 'Hi' }, 'no files → the field is left out');
  });
  it('a run that wrote files and no chat is a success only when it finished normally — a cut stream with files is not', () => {
    const files = { 'index.html': '<html></html>' };
    assert.deepEqual(judgeRun({ aborted: false, apiError: null, message: '', files, finished: true }), { ok: true, message: '', files });
    const cut = judgeRun({ aborted: false, apiError: null, message: '', files, finished: false });
    assert.equal(cut.ok, false);
    assert.match(cut.error!, /stopped before finishing/);
    assert.equal(judgeRun({ aborted: false, apiError: null, message: '', files: {}, finished: true }).ok, false, 'finished with nothing at all is still a failure');
  });
  it('Stop and API errors win over files', () => {
    const files = { 'index.html': 'x' };
    assert.deepEqual(judgeRun({ aborted: true, apiError: null, message: 'm', files, finished: true }), { ok: false, error: 'Stopped' });
    assert.deepEqual(judgeRun({ aborted: false, apiError: 'boom', message: 'm', files, finished: true }), { ok: false, error: 'boom' });
  });
});

describe('reportStageDone', () => {
  const H = { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' };
  const fake = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it('posts the outcome as the user and returns what ai-chat saved', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const out = await reportStageDone(fake(200, { ok: true, artifact: { kind: 'plan', version: 3, staled: ['manifest'] } }, seen), 'https://x/ai-chat', H, 'job-1', { ok: true, message: 'reply' });
    assert.deepEqual(out, { ok: true, artifact: { kind: 'plan', version: 3, staled: ['manifest'] } });
    assert.equal(seen.url, 'https://x/ai-chat');
    assert.deepEqual(seen.init?.headers, H);
    assert.deepEqual(JSON.parse(String(seen.init?.body)), { stage_done: { job_id: 'job-1', ok: true, message: 'reply' } });
  });

  it('sends the files along with the message', async () => {
    const seen: { init?: RequestInit } = {};
    await reportStageDone(fake(200, { ok: true, artifact: null }, seen), 'u', H, 'job-2', { ok: true, message: 'm', files: { 'index.html': '<p>hi</p>' } });
    assert.deepEqual(JSON.parse(String(seen.init?.body)), { stage_done: { job_id: 'job-2', ok: true, message: 'm', files: { 'index.html': '<p>hi</p>' } } });
  });

  it('passes a failure through with its reason', async () => {
    const out = await reportStageDone(fake(200, { ok: false, artifact: null, error: 'incomplete plan' }), 'u', H, 'j', { ok: true, message: 'x' });
    assert.deepEqual(out, { ok: false, artifact: null, error: 'incomplete plan' });
  });

  it('an HTTP error, junk, or a network failure becomes a clean "not saved" outcome — it never throws', async () => {
    const e1 = await reportStageDone(fake(404, { error: 'Job not found.' }), 'u', H, 'j', { ok: true, message: 'x' });
    assert.deepEqual(e1, { ok: false, artifact: null, error: 'Job not found.' });
    const e2 = await reportStageDone(fake(200, 'not json'), 'u', H, 'j', { ok: true, message: 'x' });
    assert.equal(e2.ok, false);
    assert.match(e2.error!, /could not be saved/);
    const e3 = await reportStageDone((async () => { throw new Error('offline'); }) as typeof fetch, 'u', H, 'j', { ok: true, message: 'x' });
    assert.equal(e3.ok, false);
    assert.match(e3.error!, /could not be saved/);
  });

  it('reports a failed run too, so the job is closed', async () => {
    const seen: { init?: RequestInit } = {};
    await reportStageDone(fake(200, { ok: false, artifact: null, error: 'Stopped' }, seen), 'u', H, 'j', { ok: false, error: 'Stopped' });
    assert.deepEqual(JSON.parse(String(seen.init?.body)), { stage_done: { job_id: 'j', ok: false, error: 'Stopped' } });
  });
});

describe('touchJob', () => {
  const fake = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  it('stamps the heartbeat on a still-running job (service role) and says "running"', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    assert.equal(await touchJob(fake(200, [{ id: 'j' }], seen), 'https://sb.test', 'svc-key', 'job 1'), 'running');
    assert.equal(seen.url, 'https://sb.test/rest/v1/build_jobs?id=eq.job%201&status=eq.running&select=id');
    assert.equal(seen.init?.method, 'PATCH');
    const h = seen.init?.headers as Record<string, string>;
    assert.equal(h.apikey, 'svc-key');
    assert.equal(h.Authorization, 'Bearer svc-key');
    assert.match(JSON.parse(String(seen.init?.body)).heartbeat_at, /^\d{4}-\d\d-\d\dT/);
  });

  it('a job that is no longer running (Stop pressed, superseded, finished) → "closed": the Worker aborts the generation', async () => {
    assert.equal(await touchJob(fake(200, []), 'https://sb.test', 'k', 'j'), 'closed');
  });

  it('trouble never aborts a good run: HTTP errors, junk, network failure, missing config → "unknown"', async () => {
    assert.equal(await touchJob(fake(500, { message: 'down' }), 'https://sb.test', 'k', 'j'), 'unknown');
    assert.equal(await touchJob(fake(200, { not: 'a list' }), 'https://sb.test', 'k', 'j'), 'unknown');
    assert.equal(await touchJob((async () => { throw new Error('offline'); }) as typeof fetch, 'https://sb.test', 'k', 'j'), 'unknown');
    assert.equal(await touchJob(fake(200, []), '', 'k', 'j'), 'unknown');
    assert.equal(await touchJob(fake(200, []), 'https://sb.test', '', 'j'), 'unknown');
  });
});

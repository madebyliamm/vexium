import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILD_DEFAULT_MESSAGE, BUILD_NOTE_MAX, backendSummary, buildBlocker, buildMessage, buildStatus, checklist, formatCost, headline, previewFileNames,
  previewFilesFromRow, previewSelect, progress, readManifest, readReport, readSteps, reportView, totalCost, type StepRow,
} from '../src/lib/build-view.ts';

const step = (seq: number, kind: StepRow['kind'], status: StepRow['status'], over: Partial<StepRow> = {}): StepRow => ({
  seq, kind, file: kind === 'page' || kind === 'fix' ? `p${seq}.html` : null, label: `${kind} ${seq}`, status, attempt: 0, detail: null, cost_cents: 0, ...over,
});

describe('buildMessage', () => {
  it('is the default line when the owner gave no direction, and the owner\'s words otherwise', () => {
    assert.equal(buildMessage(''), BUILD_DEFAULT_MESSAGE);
    assert.equal(buildMessage('   \n '), BUILD_DEFAULT_MESSAGE);
    assert.equal(buildMessage('  warmer tone  '), 'warmer tone');
    assert.equal(buildMessage('x'.repeat(BUILD_NOTE_MAX + 50)).length, BUILD_NOTE_MAX);
  });
});

describe('readSteps', () => {
  it('reads rows, coerces numeric-string costs and drops anything that is not a step', () => {
    const rows = [
      { seq: 1, kind: 'page', file: 'index.html', label: 'Building Home', status: 'done', attempt: 1, detail: null, cost_cents: '1.25' },
      { seq: 2, kind: 'nope', label: 'x', status: 'done' },
      { seq: '3', kind: 'page', label: 'x', status: 'done' },
      { seq: 4, kind: 'page', label: 'x', status: 'weird' },
      null,
      { seq: 5, kind: 'save', file: null, label: 'Saving', status: 'pending', attempt: 0, detail: '', cost_cents: null },
    ];
    const out = readSteps(rows);
    assert.deepEqual(out.map((s) => s.seq), [1, 5]);
    assert.equal(out[0]!.cost_cents, 1.25);
    assert.equal(out[1]!.cost_cents, 0);
    assert.equal(out[1]!.detail, null);
    assert.deepEqual(readSteps('nope'), []);
  });
});

describe('checklist', () => {
  const steps: StepRow[] = [
    step(101, 'save', 'pending'), step(100, 'verify', 'pending'), step(2, 'page', 'running'), step(1, 'page', 'done'), step(0, 'prepare', 'done'), step(200, 'fix', 'pending'),
  ];
  it('orders setup, pages, the check, the repairs it asked for, the save', () => {
    assert.deepEqual(checklist(steps).map((i) => i.seq), [0, 1, 2, 100, 200, 101]);
  });
  it('maps statuses to the states the screen draws', () => {
    assert.deepEqual(checklist(steps).map((i) => i.state), ['done', 'done', 'active', 'todo', 'todo', 'todo']);
  });
  it('says why a step failed, that it is trying again, and that it needed a second try', () => {
    const items = checklist([
      step(1, 'page', 'failed', { detail: 'The page was cut off.', attempt: 3 }),
      step(2, 'page', 'running', { attempt: 1 }),
      step(3, 'page', 'done', { attempt: 2 }),
      step(4, 'page', 'done', { attempt: 1 }),
      step(5, 'page', 'failed'),
    ]);
    assert.deepEqual(items.map((i) => i.note), ['The page was cut off.', 'Trying again (try 2)', 'Needed a second try', null, 'This did not work.']);
  });
  it('shows what the check found as its note', () => {
    const items = checklist([step(100, 'verify', 'running', { detail: '2 problems found — repairing 1 page' }), step(101, 'save', 'pending')]);
    assert.equal(items[0]!.note, '2 problems found — repairing 1 page');
    const done = checklist([step(100, 'verify', 'done', { detail: 'All checks passed' })]);
    assert.equal(done[0]!.note, 'All checks passed');
  });
  it('does not change the input', () => {
    const before = steps.map((s) => s.seq);
    checklist(steps);
    assert.deepEqual(steps.map((s) => s.seq), before);
  });
});

describe('progress and headline', () => {
  it('counts finished rows over all rows', () => {
    assert.deepEqual(progress([]), { done: 0, total: 0, percent: 0 });
    assert.deepEqual(progress([step(0, 'prepare', 'done'), step(1, 'page', 'running'), step(2, 'page', 'skipped'), step(3, 'save', 'pending')]), { done: 2, total: 4, percent: 50 });
  });
  it('names what is happening now', () => {
    assert.equal(headline([]), 'Getting ready…');
    const pages = [step(0, 'prepare', 'done'), step(1, 'page', 'done'), step(2, 'page', 'running'), step(3, 'page', 'pending'), step(100, 'verify', 'pending'), step(101, 'save', 'pending')];
    assert.equal(headline(pages), 'Building your pages — 1 of 3 done');
    const checking = pages.map((s) => (s.kind === 'page' ? { ...s, status: 'done' as const } : s.kind === 'verify' ? { ...s, status: 'running' as const } : s));
    assert.equal(headline(checking), 'Checking links, forms and checkout…');
    assert.equal(headline([...checking, step(200, 'fix', 'running'), step(201, 'fix', 'pending')]), 'Fixing 2 pages…');
    assert.equal(headline([...checking, step(200, 'fix', 'running')]), 'Fixing 1 page…');
    assert.equal(headline(checking.map((s) => (s.kind === 'save' ? { ...s, status: 'running' as const } : s))), 'Saving your site…');
    assert.equal(headline(checking.map((s) => (s.kind === 'verify' ? { ...s, status: 'done' as const } : s))), 'Almost there…');
  });
});

describe('cost', () => {
  it('adds the steps up and writes a small sum in dollars', () => {
    assert.equal(totalCost([step(1, 'page', 'done', { cost_cents: 12.5 }), step(2, 'page', 'done', { cost_cents: 30 })]), 42.5);
    assert.equal(formatCost(42.5), '$0.43');
    assert.equal(formatCost(310), '$3.10');
    assert.equal(formatCost(0.4), 'less than 1¢');
    assert.equal(formatCost(0), '$0.00');
    assert.equal(formatCost(Number.NaN), '$0.00');
  });
});

describe('readManifest', () => {
  const data = {
    schema: 1, built_at: '2026-10-21T10:00:00Z', shared_files: ['styles.css'], cost_cents: 18.2,
    pages: [{ file: 'shop.html', title: 'Shop', in_nav: true }, { file: 'index.html', title: 'Home', in_nav: true }, { file: '../evil.html', title: 'x' }, { file: 'notes.txt', title: 'x' }, { file: 'about.html' }],
    backend: { collections: [], products: ['candle'], forms: ['contact', 'wholesale'], auth: false },
  };
  it('lists the pages (valid .html names only), the home page first', () => {
    const m = readManifest(data)!;
    assert.deepEqual(m.pages.map((p) => p.file), ['index.html', 'shop.html', 'about.html']);
    assert.equal(m.pages[2]!.title, 'about.html', 'a page with no title is named by its file');
    assert.equal(m.pages[2]!.inNav, false);
    assert.equal(m.costCents, 18.2);
    assert.equal(m.builtAt, '2026-10-21T10:00:00Z');
  });
  it('gives up on a manifest with no usable page', () => {
    assert.equal(readManifest(null), null);
    assert.equal(readManifest({ pages: [] }), null);
    assert.equal(readManifest({ pages: [{ file: 'a/b.html' }] }), null);
  });
  it('describes the backend in plain words', () => {
    assert.equal(backendSummary(readManifest(data)!.backend), '2 forms, checkout for 1 product');
    assert.equal(backendSummary({ collections: ['tasks', 'notes'], products: [], forms: [], auth: true }), '2 data lists, accounts');
    assert.equal(backendSummary({ collections: [], products: [], forms: [], auth: false }), '');
    assert.equal(backendSummary(null), '');
    // a form's submissions live in a collection of the same name: that is the form, not a second thing
    assert.equal(backendSummary({ collections: ['contact', 'tasks'], products: [], forms: ['contact'], auth: false }), '1 form, 1 data list');
    assert.equal(backendSummary({ collections: ['contact'], products: [], forms: ['contact'], auth: false }), '1 form');
  });
});

describe('preview files', () => {
  const pages = [{ file: 'index.html', title: 'Home', inNav: true }, { file: 'shop.html', title: 'Shop', inNav: true }];
  it('reads every page plus the stylesheet and script, one quoted column each', () => {
    const names = previewFileNames(pages);
    assert.deepEqual(names, ['index.html', 'shop.html', 'styles.css', 'site.js']);
    assert.equal(previewSelect(names), 'c0:files->>"index.html",c1:files->>"shop.html",c2:files->>"styles.css",c3:files->>"site.js"');
  });
  it('maps a row back to file names, skipping empty columns', () => {
    const names = previewFileNames(pages);
    assert.deepEqual(previewFilesFromRow(names, { c0: '<html>a</html>', c1: '<html>b</html>', c2: 'body{}', c3: null }), { 'index.html': '<html>a</html>', 'shop.html': '<html>b</html>', 'styles.css': 'body{}' });
    assert.deepEqual(previewFilesFromRow(names, null), {});
  });
});

describe('the launch-check report', () => {
  const raw = {
    schema: 1, checked_at: '2026-10-21T10:00:00Z', manifest_version: 3, ok: false, open_items: ['Real product photos'],
    checks: [
      { id: 'links', label: 'Links', status: 'pass' },
      { id: 'forms', label: 'Forms', status: 'fail', detail: 'The contact form is never submitted.', page: 'contact.html' },
      { id: 'content', label: 'Real content', status: 'warn', detail: 'A photo is missing.' },
      { id: 'checkout', label: 'Checkout', status: 'skip' },
      { id: 'bad', label: 'x', status: 'maybe' },
      { label: 'no id', status: 'pass' },
    ],
  };
  it('reads the checks it understands', () => {
    const r = readReport(raw)!;
    assert.deepEqual(r.checks.map((c) => c.id), ['links', 'forms', 'content', 'checkout']);
    assert.equal(r.checks[1]!.page, 'contact.html');
    assert.equal(r.manifest_version, 3);
    assert.equal(readReport({ checks: 'x', ok: true }), null);
    assert.equal(readReport(null), null);
  });
  it('words the verdict: problems first, then things worth a look, then all clear', () => {
    assert.equal(reportView(readReport(raw)!).headline, '1 problem to fix, 1 thing worth a look');
    assert.equal(reportView(readReport(raw)!).ok, false);
    const warnOnly = readReport({ ...raw, ok: true, checks: raw.checks.filter((c) => c.status !== 'fail') })!;
    assert.equal(reportView(warnOnly).headline, 'Everything works — 1 thing worth a look');
    assert.equal(reportView(warnOnly).ok, true);
    const clear = readReport({ ...raw, ok: true, checks: raw.checks.filter((c) => c.status === 'pass' || c.status === 'skip') })!;
    assert.equal(reportView(clear).headline, 'All 1 check passed');
    assert.deepEqual(reportView(clear).openItems, ['Real product photos']);
  });
  it('a report that says ok but holds a failure is not ok', () => {
    const r = readReport({ ...raw, ok: true })!;
    assert.equal(reportView(r).ok, false);
  });
});

describe('buildStatus and buildBlocker', () => {
  it('picks one status for the screen', () => {
    assert.equal(buildStatus({ running: true, built: true, stale: true, failed: true }), 'building');
    assert.equal(buildStatus({ running: false, built: false, stale: false, failed: true }), 'failed');
    assert.equal(buildStatus({ running: false, built: false, stale: false, failed: false }), 'ready');
    assert.equal(buildStatus({ running: false, built: true, stale: true, failed: false }), 'outdated');
    assert.equal(buildStatus({ running: false, built: true, stale: false, failed: true }), 'built', 'a failed re-run does not hide the site that exists');
  });
  it('says why a build cannot start, in the order the owner would fix things', () => {
    const ok = { hasPlan: true, planStale: false, hasStyle: true, styleStale: false, styleLocked: true };
    assert.equal(buildBlocker(ok), null);
    assert.match(buildBlocker({ ...ok, hasPlan: false })!, /plan first/);
    assert.match(buildBlocker({ ...ok, planStale: true })!, /plan changed/);
    assert.match(buildBlocker({ ...ok, hasStyle: false, styleLocked: false })!, /Pick and lock/);
    assert.match(buildBlocker({ ...ok, styleStale: true })!, /out of date/);
    assert.match(buildBlocker({ ...ok, styleLocked: false })!, /Lock your style/);
  });
});

// TWEAKS server side — run:  node --test supabase/tests/tweaks.test.ts
// The real prompt pieces, finisher, handler and history move (ai-chat/tweaks*.ts, stage-handler.ts) against an in-memory fake database.
// The "model" is the test: it hands over the text a patched file would have. A tweak is all or nothing: anything that fails a check saves
// NOTHING — no file, no artifact, no checkpoint.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPut, type LatestArtifacts } from '../functions/_shared/stages.ts';
import { inputsFrom, saveLaunchReport, verifyStored } from '../functions/ai-chat/build-handler.ts';
import { requestLabel, takeCheckpoint } from '../functions/ai-chat/checkpoints.ts';
import { beginStage, finishStageRun, isHttpError, type JobRow, type StageDeps, type StageRun } from '../functions/ai-chat/stage-handler.ts';
import { finishTweaks, hooksOf, styleMoved } from '../functions/ai-chat/tweaks.ts';
import { applyTweak, moveHistory, type HistoryDeps, type MoveResult } from '../functions/ai-chat/tweaks-handler.ts';
import { cleanPointed, editableFiles, MAX_CONTEXT_CHARS, tweakContext, TWEAKS_BRIEF, TWEAKS_PROTOCOL } from '../functions/ai-chat/tweaks-prompt.ts';
import { scanPage } from '../functions/ai-chat/site-derive.ts';
import { builtSite, latestOf, PAGES, PLAN, styleOf } from './built_site.ts';
import { wrap } from './site_fixtures.ts';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'proj_1';

const SITE = builtSite();
const edit = (name: string, from: string, to: string): Record<string, string> => {
  assert.ok(SITE.files[name]!.includes(from), `fixture lost "${from}" in ${name}`);
  return { [name]: SITE.files[name]!.replace(from, to) };
};
const run = (written: Record<string, string>, over: { patchFailed?: number; files?: Record<string, string>; message?: string; locked?: boolean } = {}) =>
  finishTweaks({ message: over.message ?? 'Done.', written, patchFailed: over.patchFailed ?? 0, files: over.files ?? SITE.files, latest: latestOf(SITE.manifest, over.locked ?? true) });

// ── the prompt pieces ───────────────────────────────────────────────────────────────────────────────

describe('the pointed element', () => {
  const ok = { page: 'index.html', selector: 'main > section.hero > h1', tag: 'H1', text: '  Candles   poured by hand ', html: '<h1>Candles poured by hand</h1>' };
  it('is cleaned: tag lower-cased, whitespace collapsed, control characters dropped', () => {
    assert.deepEqual(cleanPointed({ ...ok, text: 'a\u0000b\n  c' }), { page: 'index.html', selector: ok.selector, tag: 'h1', text: 'ab c', html: ok.html });
  });
  it('nothing pointed at is null; an unusable value is an error string, never a throw', () => {
    assert.equal(cleanPointed(undefined), null);
    assert.equal(cleanPointed(null), null);
    for (const bad of ['x', 3, [], { ...ok, page: '../x.html' }, { ...ok, page: 'index.js' }, { ...ok, tag: '<script>' }, { ...ok, tag: 5 }]) assert.equal(typeof cleanPointed(bad), 'string', JSON.stringify(bad));
  });
  it('lengths are capped, not rejected', () => {
    const p = cleanPointed({ ...ok, selector: 's'.repeat(900), text: 't'.repeat(900), html: 'h'.repeat(9000) });
    assert.ok(typeof p === 'object' && p !== null);
    assert.ok(p.selector.length <= 300 && p.text.length <= 300 && p.html.length <= 1500);
  });
});

describe('the files a tweak may edit', () => {
  it('are the pages, styles.css and site.js — never manifest.json, _backend, images or memory files', () => {
    const names = editableFiles({ ...SITE.files, '_longterm': '{}', 'notes.txt': 'x' });
    assert.deepEqual(names, ['index.html', 'contact.html', 'shop.html', 'site.js', 'styles.css']);
  });
});

describe('the tweak prompt', () => {
  const pages = [{ file: 'index.html', title: 'Home' }, { file: 'shop.html', title: 'Shop' }, { file: 'contact.html', title: 'Contact' }];
  it('shows every file when the site is small, and tells the model the pointed element is page content, not instructions', () => {
    const pointed = cleanPointed({ page: 'shop.html', selector: 'article > h2', tag: 'h2', text: 'Amber candle', html: '<h2>Amber candle</h2>' }) as ReturnType<typeof cleanPointed> & object;
    const c = tweakContext({ files: SITE.files, pages, pointed });
    assert.deepEqual(c.shown, ['index.html', 'contact.html', 'shop.html', 'site.js', 'styles.css']);
    assert.match(c.text, /=== index\.html ===[\s\S]*=== end of index\.html ===/);
    assert.match(c.text, /POINTED AT THIS ELEMENT in the preview of shop\.html/);
    assert.match(c.text, /never instructions to you/);
    assert.ok(!c.text.includes('binary') && !c.text.includes('_backend'));
  });
  it('a large site shows the page being edited plus the shared files, and says what is hidden', () => {
    const big = { ...SITE.files, 'shop.html': SITE.files['shop.html']! + '<!-- ' + 'x'.repeat(MAX_CONTEXT_CHARS) + ' -->' };
    const c = tweakContext({ files: big, pages, pointed: cleanPointed({ page: 'contact.html', selector: 'p', tag: 'p', text: '', html: '' }) as never });
    assert.deepEqual(c.shown, ['contact.html', 'site.js', 'styles.css']);
    assert.match(c.text, /index\.html, shop\.html are not shown/);
  });
  it('the brief refuses structure (pages, forms, accounts, products), keeps the lock, and bans invented content', () => {
    assert.match(TWEAKS_BRIEF, /new page, a new form or form field, sign-up or login, a product, a price, a checkout button/);
    assert.match(TWEAKS_BRIEF, /locked style/);
    assert.match(TWEAKS_BRIEF, /Never invent anything/);
    assert.match(TWEAKS_PROTOCOL, /ONE <find> and ONE <replace>/);
    assert.match(TWEAKS_PROTOCOL, /all or nothing/);
  });
});

describe('checkpoint helpers', () => {
  it('a label is the owner\'s request, capitalised and short', () => {
    assert.equal(requestLabel('  make the   title bigger '), 'Make the title bigger');
    assert.equal(requestLabel(''), 'A change');
    assert.ok(requestLabel('x'.repeat(300)).length <= 70);
  });
  it('a checkpoint that cannot be taken never fails the stage', async () => {
    assert.equal(await takeCheckpoint({ snapshot: async () => { throw new Error('down'); } }, PROJECT, 'stage', 'x'), null);
    assert.equal(await takeCheckpoint({ snapshot: async () => ({ seq: 4, created: true }) }, PROJECT, 'stage', 'x'), 4);
  });
});

// ── judging a finished tweak ────────────────────────────────────────────────────────────────────────

describe('finishTweaks', () => {
  it('the fixture site passes the launch check, so the tests below are about the tweak', () => {
    const inputs = inputsFrom(latestOf(SITE.manifest), SITE.files);
    assert.ok(typeof inputs !== 'string');
    assert.deepEqual(verifyStored(inputs, SITE.files).problems.filter((p) => p.severity === 'fail'), []);
  });

  it('a chat-only turn changes nothing', () => {
    const r = run({}, { message: 'Which heading do you mean?' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.files, {});
    assert.equal(r.report, null);
    assert.equal(r.chat, 'Which heading do you mean?');
  });

  it('a file that came back identical is not a change', () => {
    assert.deepEqual(run({ 'index.html': SITE.files['index.html']! }).files, {});
  });

  it('a text change saves exactly that file and brings a fresh launch check', () => {
    const r = run(edit('index.html', 'Candles poured by hand', 'Candles poured with care'));
    assert.equal(r.error, undefined);
    assert.deepEqual(Object.keys(r.files), ['index.html']);
    assert.match(r.files['index.html']!, /poured with care/);
    assert.equal(r.style, null);
    assert.equal(r.report!.ok, true);
  });

  it('any patch that did not fit throws the WHOLE change away', () => {
    const r = run(edit('index.html', 'Candles poured by hand', 'Candles poured with care'), { patchFailed: 1 });
    assert.match(r.error!, /didn't fit your page, so none of it was made/);
    assert.match(r.error!, /Nothing was changed\.$/);
    assert.deepEqual(r.files, {});
    assert.match(run({}, { patchFailed: 2 }).error!, /didn't fit/);
  });

  it('only the pages, styles.css and site.js may change', () => {
    for (const name of ['manifest.json', '_backend', 'logo.png', 'new.html', 'x.txt']) {
      const r = run({ [name]: 'something else' });
      assert.match(r.error ?? '', /can't be changed here/, name);
    }
  });

  it('refuses to drop most of a page, to cut a script off, or to leave a file huge', () => {
    assert.match(run({ 'index.html': '<!DOCTYPE html><html></html>' }, { files: { ...SITE.files, 'index.html': SITE.files['index.html']! + ' '.repeat(2000) } }).error!, /removed most of a page/);
    assert.match(run({ 'site.js': 'window.VX_SITE = {' }).error!, /broken the menu or footer/);
    // the Worker's last-resort patch match squeezes a file's whitespace: a script with `//` comments would end at the first one
    const script = ['// menu', 'window.VX_SITE = {', ...Array.from({ length: 12 }, (_, n) => `  k${n}: ${n}, // note`), '};', ''].join('\n');
    const squeezed = script.replace(/\s+/g, ' ');
    assert.match(run({ 'site.js': squeezed }, { files: { ...SITE.files, 'site.js': script } }).error!, /broken the menu or footer/);
    assert.equal(run({ 'site.js': script.replace('k3: 3', 'k3: 33') }, { files: { ...SITE.files, 'site.js': script } }).error, undefined);
    assert.match(run({ 'styles.css': SITE.files['styles.css']! + '/*' + 'x'.repeat(300_000) + '*/' }).error!, /too large/);
  });

  it('breaking what the platform checks is refused: a missing stylesheet link', () => {
    const r = run(edit('index.html', '<link rel="stylesheet" href="styles.css"/>', ''));
    assert.match(r.error!, /broken your site/);
    assert.deepEqual(r.files, {});
  });

  it('a problem the site already had does not stop a tweak elsewhere', () => {
    const lorem = wrap('Shop', `<section><h1>Shop</h1><article><h2>Amber candle</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><button data-vx-buy="candle">Buy now</button></article></section>`);
    const flawed = builtSite({ ...PAGES, 'shop.html': lorem });
    const l = latestOf(flawed.manifest);
    const before = verifyStored(inputsFrom(l, flawed.files) as never, flawed.files);
    assert.ok(before.problems.some((p) => p.severity === 'fail'), 'the fixture should have a failing check');
    const r = finishTweaks({ message: 'ok', written: { 'index.html': flawed.files['index.html']!.replace('poured by hand', 'poured by us') }, patchFailed: 0, files: flawed.files, latest: l });
    assert.equal(r.error, undefined);
    assert.deepEqual(Object.keys(r.files), ['index.html']);
  });

  describe('forms, sign-in and buy buttons belong to the backend', () => {
    it('their wording, order and look may change', () => {
      const html = SITE.files['contact.html']!;
      const reworded = html.replace('<label>Email <input', '<label>Your email address <input').replace('<button type="submit">Send</button>', '<button type="submit" class="big">Send it</button>');
      const swapped = html.replace(/(<label>Email[^]*?<\/label>)(<label>Message[^]*?<\/label>)/, '$2$1');
      assert.notEqual(swapped, html);
      for (const written of [reworded, swapped]) {
        const r = run({ 'contact.html': written });
        assert.equal(r.error, undefined);
        assert.deepEqual(Object.keys(r.files), ['contact.html']);
      }
    });
    it('a field added, removed or renamed, a form id changed, or a buy button changed is refused with a pointer to Plan', () => {
      const html = SITE.files['contact.html']!;
      const cases: Record<string, Record<string, string>> = {
        removed: { 'contact.html': html.replace(/<label>Message[^]*?<\/label>/, '') },
        renamed: { 'contact.html': html.replace('name="message"', 'name="note"') },
        added: { 'contact.html': html.replace('<button type="submit">', '<input name="phone" type="text"><button type="submit">') },
        retyped: { 'contact.html': html.replace('type="email"', 'type="text"') },
        formId: { 'contact.html': html.replace('data-vx-form="contact"', 'data-vx-form="enquiry"') },
        buy: edit('shop.html', 'data-vx-buy="candle"', 'data-vx-buy="other"'),
        unhooked: edit('shop.html', ' data-vx-buy="candle"', ''),
      };
      for (const [what, written] of Object.entries(cases)) {
        const r = run(written);
        assert.match(r.error ?? '', /form, a sign-in box or a buy button.*Plan/, what);
        assert.deepEqual(r.files, {}, what);
      }
    });
    it('hooksOf ignores the order of fields and forms', () => {
      const a = scanPage('c.html', SITE.files['contact.html']!);
      const b = scanPage('c.html', SITE.files['contact.html']!.replace(/(<label>Email[^]*?<\/label>)(<label>Message[^]*?<\/label>)/, '$2$1'));
      assert.equal(hooksOf(a), hooksOf(b));
    });
  });

  describe('the style', () => {
    it('a moved token is a new style_spec: the lock is kept, the stylesheet and manifest.json follow, the report is for the new look', () => {
      const css = SITE.files['styles.css']!;
      assert.match(css, /--accent: #b4532a/i);
      const r = run({ 'styles.css': css.replace(/--accent: #b4532a/i, '--accent: #2f7d4f') });
      assert.equal(r.error, undefined);
      assert.ok(r.style, 'the style moved');
      assert.equal(r.style!.locked, true);
      assert.equal(r.style!.tokens['--accent'], '#2f7d4f');
      assert.match(r.files['styles.css']!, /--accent: #2f7d4f/i);
      assert.match(r.files['manifest.json']!, /#2f7d4f/i);
      assert.equal(r.report!.ok, true);
    });
    it('a rule that moves no token and no font leaves the style alone', () => {
      const r = run({ 'styles.css': SITE.files['styles.css']! + '\n.hero h1 { letter-spacing: -0.02em; }\n' });
      assert.equal(r.error, undefined);
      assert.equal(r.style, null);
      assert.deepEqual(Object.keys(r.files), ['styles.css']);
    });
    it('a stylesheet that lost its colours is refused', () => {
      const r = run({ 'styles.css': SITE.files['styles.css']!.replace(/--bg:[^;]*;/, '') });
      assert.match(r.error ?? '', /left the style incomplete/);
    });
    it('styleMoved: null when nothing moved, a spec with the same lock when something did', () => {
      const current = styleOf(SITE.files['styles.css']!);
      assert.equal(styleMoved(SITE.files['styles.css']!, current), null);
      const moved = styleMoved(SITE.files['styles.css']!.replace(/--accent: #b4532a/i, '--accent: #123456'), { ...current, locked: false });
      assert.ok(typeof moved === 'object' && moved !== null);
      assert.equal(moved.locked, false);
    });
  });
});

// ── applying a tweak ────────────────────────────────────────────────────────────────────────────────

interface Db {
  files: Record<string, string>;
  latest: LatestArtifacts;
  log: string[];
  snapshots: { kind: string; label: string }[];
  fail: { files: boolean; artifacts: boolean };
}
function db(): Db & { deps: Parameters<typeof applyTweak>[1] } {
  const d = { files: { ...SITE.files }, latest: latestOf(SITE.manifest), log: [] as string[], snapshots: [] as { kind: string; label: string }[], fail: { files: false, artifacts: false } } as Db & { deps: Parameters<typeof applyTweak>[1] };
  d.deps = {
    async getProjectFiles() { return { ...d.files }; },
    async getLatestArtifacts() { return d.latest; },
    async saveFiles(_p, files) { if (d.fail.files) throw new Error('set_project_files down'); d.files = { ...d.files, ...files }; d.log.push(`files:${Object.keys(files).join(',')}`); },
    async snapshot(_p, kind, label) { d.snapshots.push({ kind, label }); d.log.push('snapshot'); return { seq: d.snapshots.length, created: true }; },
    async saveArtifact(_p, kind, data) {
      if (d.fail.artifacts) throw new Error('put_project_artifact down');
      const r = applyPut(d.latest, kind, data);
      d.latest = r.latest;
      d.log.push(`artifact:${kind}`);
      return { version: r.version, staled: r.staled };
    },
  };
  return d;
}
const apply = (d: ReturnType<typeof db>, written: Record<string, string>, over: { patchFailed?: number; message?: string; request?: string } = {}) =>
  applyTweak({ projectId: PROJECT, request: over.request ?? 'make the headline warmer', message: over.message ?? 'Made the headline warmer.', written, patchFailed: over.patchFailed ?? 0 }, d.deps);

describe('applyTweak', () => {
  it('saves the files first, then the checkpoint, then a launch report for the CURRENT manifest', async () => {
    const d = db();
    const manifestVersion = d.latest.manifest!.version;
    const r = await apply(d, edit('index.html', 'Candles poured by hand', 'Candles poured with care'));
    assert.equal(r.ok, true);
    assert.deepEqual(d.log, ['files:index.html', 'snapshot', 'artifact:launch_checks']);
    assert.deepEqual(d.snapshots, [{ kind: 'tweak', label: 'Make the headline warmer' }]);
    assert.match(d.files['index.html']!, /poured with care/);
    assert.equal((d.latest.launch_checks!.data as { manifest_version: number }).manifest_version, manifestVersion);
    assert.deepEqual(r.artifact, { kind: 'launch_checks', version: d.latest.launch_checks!.version, staled: [] });
    assert.deepEqual(r.changed, ['index.html']);
  });

  it('a moved style saves the style (staling the build and its report) and then re-saves the build as current', async () => {
    const d = db();
    const r = await apply(d, { 'styles.css': SITE.files['styles.css']!.replace(/--accent: #b4532a/i, '--accent: #2f7d4f') });
    assert.equal(r.ok, true);
    assert.deepEqual(d.log, ['files:styles.css,manifest.json', 'snapshot', 'artifact:style_spec', 'artifact:manifest', 'artifact:launch_checks']);
    assert.equal(d.latest.style_spec!.stale, false);
    assert.equal((d.latest.style_spec!.data as { locked: boolean }).locked, true);
    assert.equal(d.latest.manifest!.stale, false);
    assert.equal(d.latest.launch_checks!.stale, false);
    assert.equal((d.latest.launch_checks!.data as { manifest_version: number }).manifest_version, d.latest.manifest!.version);
  });

  it('a refused tweak saves nothing at all', async () => {
    const d = db();
    const r = await apply(d, edit('contact.html', 'name="message"', 'name="note"'));
    assert.equal(r.ok, false);
    assert.match(r.error!, /Nothing was changed/);
    assert.deepEqual(d.log, []);
    assert.deepEqual(d.files, SITE.files);
  });

  it('a chat-only turn saves nothing and keeps the reply', async () => {
    const d = db();
    const r = await apply(d, {}, { message: 'Do you mean the big headline?' });
    assert.deepEqual([r.ok, r.chat, r.artifact, d.log], [true, 'Do you mean the big headline?', null, []]);
  });

  it('files that cannot be saved fail the tweak with nothing taken', async () => {
    const d = db();
    d.fail.files = true;
    const r = await apply(d, edit('index.html', 'Candles poured by hand', 'x poured by hand'));
    assert.equal(r.ok, false);
    assert.match(r.error!, /could not be saved/);
    assert.deepEqual(d.snapshots, []);
  });

  it('a launch report that cannot be refreshed does not undo a change that was made — it says so', async () => {
    const d = db();
    d.fail.artifacts = true;
    const r = await apply(d, edit('index.html', 'Candles poured by hand', 'Candles poured with care'));
    assert.equal(r.ok, true);
    assert.match(r.chat, /Check again/);
    assert.equal(r.artifact, null);
    assert.match(d.files['index.html']!, /with care/);
    assert.equal(d.snapshots.length, 1, 'the checkpoint was still taken');
  });
});

// ── the stage flow around it ────────────────────────────────────────────────────────────────────────

function world() {
  const d = db();
  const jobs = new Map<string, JobRow>();
  const chat: { role: string; content: string }[] = [];
  const deps: StageDeps = {
    ...d.deps,
    async getProjectAccess(p, u) { return p === PROJECT && u === OWNER ? { name: 'Wick & Co', stage: 'tweaks' } : null; },
    async usageGate() { return null; },
    async createJob(j) { const id = `00000000-0000-4000-8000-${String(jobs.size + 1).padStart(12, '0')}`; jobs.set(id, { id, project_id: j.project_id, user_id: j.user_id, stage: j.stage, status: 'running', prompt: j.prompt }); return id; },
    async getJob(id) { return jobs.get(id) ?? null; },
    async finishJob(id, patch) { const j = jobs.get(id) as (JobRow & { error?: string }) | undefined; if (j && j.status === 'running') Object.assign(j, patch); },
    async lastMessage() { return null; },
    async saveMessage(m) { chat.push({ role: m.role, content: m.content }); },
  };
  return { d, deps, jobs, chat };
}
const ask = (text: string, extra: Record<string, unknown> = {}) => ({ stage: 'tweaks', project_id: PROJECT, messages: [{ role: 'user', content: text }], ...extra });

describe('a tweak run through beginStage / finishStageRun', () => {
  it('prepares a Sonnet patch run: the plan and style are cached, the site files and the element are not, the Worker gets the files to patch', async () => {
    const w = world();
    const r = await beginStage(ask('make this bigger', { pointed: { page: 'index.html', selector: 'h1', tag: 'h1', text: 'Candles poured by hand', html: '<h1>Candles poured by hand</h1>' } }), OWNER, w.deps);
    assert.ok(!isHttpError(r) && r.kind === 'run');
    const run = r as StageRun;
    assert.equal(run.prompt.model, 'build');
    assert.match(run.prompt.system, /STAGE: TWEAKS/);
    assert.match(run.prompt.system, /Hand-poured candles/); // the plan
    assert.ok(!run.prompt.system.includes('Candles poured by hand'), 'site text stays out of the cached block');
    assert.match(run.prompt.suffix, /POINTED AT THIS ELEMENT/);
    assert.match(run.prompt.suffix, /=== styles\.css ===/);
    assert.deepEqual(Object.keys(run.filesForPatching!), ['index.html', 'contact.html', 'shop.html', 'site.js', 'styles.css']);
    assert.equal(run.filesForPatching!['index.html'], SITE.files['index.html']);
  });

  it('keeps "the site before your changes" as a checkpoint first', async () => {
    const w = world();
    await beginStage(ask('make this bigger'), OWNER, w.deps);
    assert.deepEqual(w.d.snapshots, [{ kind: 'baseline', label: 'Before your changes' }]);
  });

  it('needs a built site, and refuses a bad element description', async () => {
    const w = world();
    w.d.latest = latestOf(SITE.manifest);
    delete w.d.latest.manifest;
    const noBuild = await beginStage(ask('hi'), OWNER, w.deps);
    assert.ok(isHttpError(noBuild) && noBuild.status === 409 && noBuild.body.code === 'stage_inputs');
    w.d.latest = latestOf(SITE.manifest);
    const bad = await beginStage(ask('hi', { pointed: { page: '../etc/passwd', tag: 'h1' } }), OWNER, w.deps);
    assert.ok(isHttpError(bad) && bad.status === 400 && bad.body.code === 'bad_pointed');
  });

  it('the Worker reports a finished tweak: files, a checkpoint, the chat line, the job closed', async () => {
    const w = world();
    const run = await beginStage(ask('say poured with care'), OWNER, w.deps) as StageRun;
    const res = await finishStageRun({ job_id: run.jobId, ok: true, message: 'Changed the headline.', files: edit('index.html', 'poured by hand', 'poured with care') }, OWNER, w.deps, true);
    assert.ok(!isHttpError(res));
    assert.equal(res.body.ok, true);
    assert.deepEqual((res.body as { changed?: string[] }).changed, ['index.html']);
    assert.match(w.d.files['index.html']!, /poured with care/);
    assert.deepEqual(w.d.snapshots.map((s) => s.kind), ['baseline', 'tweak']);
    assert.equal(w.jobs.get(run.jobId)!.status, 'complete');
    assert.deepEqual(w.chat.at(-1), { role: 'assistant', content: 'Changed the headline.' });
  });

  it('a run with a patch that did not fit fails the job with a plain reason and changes nothing', async () => {
    const w = world();
    const run = await beginStage(ask('say poured with care'), OWNER, w.deps) as StageRun;
    const res = await finishStageRun({ job_id: run.jobId, ok: true, message: 'Changed it.', files: edit('index.html', 'poured by hand', 'poured with care'), patch_failed: 1 }, OWNER, w.deps, true);
    assert.ok(!isHttpError(res));
    assert.equal(res.body.ok, false);
    assert.match(res.body.error!, /none of it was made/);
    assert.equal(w.jobs.get(run.jobId)!.status, 'failed');
    assert.deepEqual(w.d.files, SITE.files);
    assert.equal(w.chat.filter((m) => m.role === 'assistant').length, 0);
  });

  it('only the build service may report a run', async () => {
    const w = world();
    const run = await beginStage(ask('x'), OWNER, w.deps) as StageRun;
    const res = await finishStageRun({ job_id: run.jobId, ok: true, message: 'x', files: {} }, OWNER, w.deps, false);
    assert.ok(isHttpError(res) && res.status === 403);
  });
});

// ── undo / redo / restore ───────────────────────────────────────────────────────────────────────────

function historyWorld(move: MoveResult, afterFiles?: Record<string, string>) {
  const d = db();
  const calls: string[] = [];
  const deps: HistoryDeps = {
    ...d.deps,
    async getProjectAccess(p, u) { return p === PROJECT && u === OWNER ? { name: 'x', stage: 'tweaks' } : null; },
    async supersedeRunning(_p, reason) { calls.push(`supersede:${reason}`); },
    async moveHistory(_p, action, seq) {
      calls.push(`move:${action}:${seq}`);
      if (move.moved && afterFiles) d.files = { ...d.files, ...afterFiles };
      return move;
    },
  };
  return { d, deps, calls };
}

describe('moveHistory', () => {
  it('cancels a run in flight BEFORE it moves, then keeps the launch report in step', async () => {
    const w = historyWorld({ moved: true, seq: 2, kind: 'stage', label: 'Full build' });
    const r = await moveHistory({ project_id: PROJECT, action: 'undo' }, OWNER, w.deps);
    assert.equal(r.status, 200);
    assert.deepEqual(w.calls, ['supersede:Superseded by a change of version', 'move:undo:null']);
    assert.deepEqual([r.body.ok, r.body.moved, r.body.seq, r.body.label, r.body.checked], [true, true, 2, 'Full build', true]);
    assert.deepEqual(w.d.log, ['artifact:launch_checks']);
  });

  it('restore needs a version; unknown actions and strangers are refused without touching anything', async () => {
    const w = historyWorld({ moved: true, seq: 1, kind: 'stage', label: 'x' });
    assert.equal((await moveHistory({ project_id: PROJECT, action: 'restore' }, OWNER, w.deps)).body.code, 'bad_seq');
    assert.equal((await moveHistory({ project_id: PROJECT, action: 'restore', seq: 1.5 }, OWNER, w.deps)).body.code, 'bad_seq');
    assert.equal((await moveHistory({ project_id: PROJECT, action: 'wipe' }, OWNER, w.deps)).body.code, 'bad_action');
    assert.equal((await moveHistory({ action: 'undo' }, OWNER, w.deps)).body.code, 'bad_project');
    assert.equal((await moveHistory({ project_id: PROJECT, action: 'undo' }, 'someone-else', w.deps)).status, 404);
    assert.deepEqual(w.calls, []);
  });

  it('says why nothing moved, in plain words', async () => {
    for (const [reason, text] of [['nothing_to_undo', /oldest/], ['nothing_to_redo', /newest/], ['not_found', /no longer saved/], ['no_history', /no saved versions/]] as const) {
      const w = historyWorld({ moved: false, reason });
      const r = await moveHistory({ project_id: PROJECT, action: 'redo' }, OWNER, w.deps);
      assert.deepEqual([r.status, r.body.moved, r.body.reason], [200, false, reason]);
      assert.match(String(r.body.error), text);
      assert.deepEqual(w.d.log, [], 'no check when nothing moved');
    }
  });

  it('files that come back with another palette bring the saved style (lock kept), the build and manifest.json with them', async () => {
    const css = SITE.files['styles.css']!.replace(/--accent: #b4532a/i, '--accent: #6b21a8');
    const w = historyWorld({ moved: true, seq: 3, kind: 'tweak', label: 'Purple' }, { 'styles.css': css });
    const r = await moveHistory({ project_id: PROJECT, action: 'restore', seq: 3 }, OWNER, w.deps);
    assert.equal(r.body.checked, true);
    assert.deepEqual(w.d.log, ['artifact:style_spec', 'artifact:manifest', 'files:manifest.json', 'artifact:launch_checks']);
    assert.equal((w.d.latest.style_spec!.data as { tokens: Record<string, string>; locked: boolean }).tokens['--accent'], '#6b21a8');
    assert.equal((w.d.latest.style_spec!.data as { locked: boolean }).locked, true);
    assert.match(w.d.files['manifest.json']!, /#6b21a8/i);
    assert.equal(w.d.latest.launch_checks!.stale, false);
  });

  it('a check that cannot be refreshed still reports the move', async () => {
    const w = historyWorld({ moved: true, seq: 2, kind: 'stage', label: 'Full build' });
    w.d.fail.artifacts = true;
    const r = await moveHistory({ project_id: PROJECT, action: 'undo' }, OWNER, w.deps);
    assert.deepEqual([r.status, r.body.ok, r.body.moved, r.body.checked], [200, true, true, false]);
  });
});

describe('saveLaunchReport', () => {
  it('writes a report for the manifest version it is given', async () => {
    const d = db();
    const inputs = inputsFrom(d.latest, d.files);
    assert.ok(typeof inputs !== 'string');
    const v = await saveLaunchReport(d.deps, PROJECT, verifyStored(inputs, d.files), 7);
    assert.equal(typeof v, 'number');
    assert.equal((d.latest.launch_checks!.data as { manifest_version: number }).manifest_version, 7);
  });
});

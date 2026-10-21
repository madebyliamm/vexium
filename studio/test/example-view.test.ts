import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXAMPLE_FILES, FIRST_RUN_MESSAGE, REDO_MESSAGE, STATUS_LABELS, controlsClosedReason, controlsView, draftCss, exampleStatus, filesToMap, hasExample, isDirty,
  lastAssistantLine, livePreviewFiles, pickFiles, planSave, previewProblem, progressSteps, readStyleSpec, readabilityHints, runMessage, sameStyle, specToSave,
} from '../src/lib/example-view.ts';
import { ACCENTS, applyStyleSpec, deriveStyleSpec, manifestWithStyle, withVibe } from '../src/lib/style.ts';
import { validateArtifact } from '../src/types/artifacts.ts';

const CSS = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;600&display=swap');
:root {
  --bg: #f6f1e9;  --surface: #ffffff;  --surface-2: #efe8dc;  --border: #e2d8c8;
  --text: #1f1a17;  --text-muted: #6b6258;
  --accent: #b4532a;  --accent-contrast: #ffffff;
  --font-display: 'Fraunces', Georgia, serif;  --font-body: 'Inter', system-ui, sans-serif;
  --radius: 12px;  --radius-lg: 20px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.06);  --shadow-lg: 0 20px 50px -12px rgba(0,0,0,.2);
  --container: 1200px;  --nav-h: 68px;  --section-y: clamp(80px, 12vw, 160px)
}
body { background: var(--bg); color: var(--text); font-family: var(--font-body); }
`;
const HTML = '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body>' + '<section id="hero"><h1>Bean There</h1></section>'.repeat(8) + '<script src="site.js"></script></body></html>';
const MANIFEST = JSON.stringify({ name: 'Bean There', background_color: '#000000', theme_color: '#000000' }, null, 2);

// What the finisher stores: the spec derived from the CSS, with the CSS and manifest written from the spec.
function stored() {
  const spec = deriveStyleSpec(CSS, { tone: 'warm and friendly', voice: 'Warm and plain.' }).spec;
  const files = pickFiles({ 'index.html': HTML, 'styles.css': applyStyleSpec(CSS, spec), 'site.js': 'window.SITE={name:"Bean There"}', 'manifest.json': manifestWithStyle(MANIFEST, spec) });
  return { spec, files };
}

describe('files', () => {
  it('picks the four example files and nothing else, as strings', () => {
    const f = pickFiles({ 'index.html': 'a', 'styles.css': 'b', 'site.js': 'c', 'manifest.json': 'd', 'about.html': 'x', other: 5 });
    assert.deepEqual(f, { html: 'a', css: 'b', js: 'c', manifest: 'd' });
    assert.deepEqual(pickFiles(null), { html: '', css: '', js: '', manifest: '' });
    assert.deepEqual(pickFiles({ 'index.html': 5 }), { html: '', css: '', js: '', manifest: '' });
    assert.deepEqual(Object.keys(filesToMap(f)).sort(), [...EXAMPLE_FILES].sort());
  });

  it('only counts a real style + real files as a built example', () => {
    const { spec, files } = stored();
    assert.equal(hasExample(spec, files), true);
    assert.equal(hasExample(null, files), false);
    assert.equal(hasExample(spec, pickFiles({ 'index.html': '<body>\n\n</body>' })), false, 'the empty starter page is not an example');
    assert.equal(hasExample(spec, { ...files, css: '' }), false);
  });

  it('reads a stored style_spec, and refuses anything invalid', () => {
    const { spec } = stored();
    assert.deepEqual(readStyleSpec(JSON.parse(JSON.stringify(spec))), spec);
    assert.equal(readStyleSpec(null), null);
    assert.equal(readStyleSpec({ schema: 1, locked: 'yes' }), null);
    assert.equal(readStyleSpec({ ...spec, tokens: { '--accent': 'red; } body { display: none' } }), null);
  });
});

describe('what the finisher stores is already in step', () => {
  it('a freshly built example is not "unsaved"', () => {
    const { spec, files } = stored();
    assert.equal(draftCss(files.css, spec), files.css, 'applying the stored style to the stored CSS changes nothing');
    assert.equal(isDirty(spec, files, spec), false);
    assert.deepEqual(planSave(spec, files, spec), { artifact: false, files: {}, nothing: true });
  });
});

describe('vibe changes → what a save has to write', () => {
  it('a colour change rewrites the stylesheet and the manifest and the style, nothing else', () => {
    const { spec, files } = stored();
    const draft = withVibe(spec, { accent: ACCENTS.find((a) => a.id === 'teal')!.hex });
    assert.equal(sameStyle(spec, draft), false);
    const plan = planSave(spec, files, draft);
    assert.equal(plan.artifact, true);
    assert.deepEqual(Object.keys(plan.files).sort(), ['manifest.json', 'styles.css']);
    assert.match(plan.files['styles.css']!, /--accent:\s*#0f766e/i);
    assert.equal(JSON.parse(plan.files['manifest.json']!).theme_color, '#0f766e');
    assert.equal(isDirty(spec, files, draft), true);
    assert.equal(validateArtifact('style_spec', specToSave(draft, false)).ok, true);
  });

  it('theme, fonts, spacing and tone each change the draft stylesheet', () => {
    const { spec, files } = stored();
    for (const change of [{ theme: 'dark' }, { pairing: 'technical' }, { density: 'airy' }, { tone: 'bold' }] as const) {
      const draft = withVibe(spec, change);
      assert.notEqual(draftCss(files.css, draft), files.css, JSON.stringify(change));
      assert.equal(isDirty(spec, files, draft), true, JSON.stringify(change));
    }
  });

  it('choosing the same thing twice is one change; discarding returns to the saved look', () => {
    const { spec, files } = stored();
    const there = withVibe(spec, { density: 'airy' });
    assert.equal(sameStyle(there, withVibe(there, { density: 'airy' })), true);
    assert.equal(isDirty(spec, files, spec), false);
  });

  it('a lock change alone saves the style but touches no file', () => {
    const { spec, files } = stored();
    const locked = specToSave(spec, true);
    assert.equal(locked.locked, true);
    assert.equal(sameStyle(spec, locked), true, 'the lock is not part of the look');
    assert.equal(planSave(spec, files, locked).nothing, true, 'planSave is about the look; the lock is saved by the caller');
  });

  it('a half-finished save is still unsaved: the style is saved, the stylesheet is not', () => {
    const { spec, files } = stored();
    const draft = withVibe(spec, { theme: 'dark' });
    const afterArtifactOnly = planSave(draft, files, draft); // saved spec == draft, files untouched
    assert.equal(afterArtifactOnly.artifact, false);
    assert.deepEqual(Object.keys(afterArtifactOnly.files), ['styles.css', 'manifest.json'].filter((f) => f in afterArtifactOnly.files));
    assert.equal(afterArtifactOnly.nothing, false);
    // …and once the files are written the same draft is clean.
    const written = pickFiles({ ...filesToMap(files), ...afterArtifactOnly.files });
    assert.equal(isDirty(draft, written, draft), false);
  });

  it('an unreadable manifest is left as it was', () => {
    const { spec, files } = stored();
    const odd = { ...files, manifest: 'not json' };
    assert.equal(planSave(spec, odd, withVibe(spec, { theme: 'dark' })).files['manifest.json'], undefined);
  });
});

describe('controlsView', () => {
  it('reports the selected choices, and which colour', () => {
    const v = controlsView(withVibe(stored().spec, { accent: ACCENTS[3]!.hex, pairing: 'editorial', density: 'compact', tone: 'bold', theme: 'dark' }));
    assert.equal(v.theme, 'dark');
    assert.equal(v.accentId, ACCENTS[3]!.id);
    assert.equal(v.pairing, 'editorial');
    assert.equal(v.density, 'compact');
    assert.equal(v.tone, 'bold');
  });
  it('a custom colour matches no swatch; the model\'s own fonts match no pairing', () => {
    const v = controlsView(withVibe(stored().spec, { accent: '#123456' }));
    assert.equal(v.accentId, null);
    assert.equal(v.accent, '#123456');
    const own = stored().spec;
    own.fonts = { ...own.fonts, display: 'Lora' };
    assert.equal(controlsView(own).pairing, null);
    assert.equal(controlsView(stored().spec).pairing, 'editorial', 'the test stylesheet uses the Editorial pairing');
  });
});

describe('readabilityHints', () => {
  it('is quiet for a readable style and speaks up for a faint accent or unreadable text', () => {
    const { spec } = stored();
    assert.deepEqual(readabilityHints(spec), []);
    assert.equal(readabilityHints(withVibe(spec, { accent: '#fde68a' })).length, 1);
    const bad = { ...spec, tokens: { ...spec.tokens, '--text': '#eeeeee' } };
    assert.match(readabilityHints(bad).join(' '), /text is hard to read/);
  });
  it('every preset accent holds up on its own dark theme', () => {
    for (const a of ACCENTS) assert.deepEqual(readabilityHints(withVibe(stored().spec, { theme: 'dark', accent: a.hex })), [], a.id);
  });
});

describe('progress while the page is built', () => {
  it('walks the four steps in order', () => {
    assert.deepEqual(progressSteps({}).map((s) => s.state), ['active', 'todo', 'todo', 'todo']);
    assert.deepEqual(progressSteps({ 'styles.css': 'x', 'index.html': 'y' }).map((s) => s.state), ['done', 'done', 'active', 'todo']);
    assert.deepEqual(progressSteps(Object.fromEntries(EXAMPLE_FILES.map((f) => [f, 'x']))).map((s) => s.state), ['done', 'done', 'done', 'done']);
    assert.ok(progressSteps({}).every((s) => s.label && !s.label.includes('.')), 'plain words, no file names');
  });
  it('an empty file is not a finished one', () => {
    assert.equal(progressSteps({ 'styles.css': '' })[0]!.state, 'active');
  });
  it('shows the page while it is built as soon as it, its stylesheet and its menu details are in', () => {
    assert.equal(livePreviewFiles({ 'styles.css': 'a', 'index.html': 'b' }), null);
    assert.deepEqual(livePreviewFiles({ 'styles.css': 'a', 'index.html': 'b', 'site.js': 'c' }), { css: 'a', html: 'b', js: 'c', manifest: '' });
  });
});

describe('wording and states', () => {
  it('uses the owner\'s note, or a default for a first build / a redo', () => {
    assert.equal(runMessage('', true), FIRST_RUN_MESSAGE);
    assert.equal(runMessage('   ', false), REDO_MESSAGE);
    assert.equal(runMessage('  bolder  ', false), 'bolder');
    assert.equal(runMessage('x'.repeat(5000), true).length, 2000);
  });
  it('picks one status', () => {
    const base = { running: false, built: true, dirty: false, locked: false };
    assert.equal(exampleStatus({ ...base, running: true }), 'building');
    assert.equal(exampleStatus({ ...base, built: false }), 'not_built');
    assert.equal(exampleStatus({ ...base, dirty: true }), 'unsaved');
    assert.equal(exampleStatus({ ...base, locked: true }), 'locked');
    assert.equal(exampleStatus(base), 'unlocked');
    for (const s of Object.values(STATUS_LABELS)) assert.ok(s.length > 0);
  });
  it('says why the controls are closed', () => {
    assert.equal(controlsClosedReason({ running: false, locked: false, saving: false }), null);
    assert.match(controlsClosedReason({ running: true, locked: true, saving: false })!, /being built/);
    assert.match(controlsClosedReason({ running: false, locked: true, saving: false })!, /Unlock/);
  });
  it('finds the last thing the assistant said', () => {
    assert.equal(lastAssistantLine([]), '');
    assert.equal(lastAssistantLine([{ role: 'assistant', content: 'one' }, { role: 'user', content: 'x' }, { role: 'assistant', content: ' two ' }, { role: 'user', content: 'y' }]), 'two');
  });
  it('words a page error', () => {
    assert.match(previewProblem(''), /reported an error/);
    assert.ok(previewProblem('x'.repeat(500)).length < 220);
  });
});
